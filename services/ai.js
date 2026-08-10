/**
 * Módulo de Generación y Revisión de Proyectos con IA.
 * 
 * Este orquestador utiliza OpenRouter (a través del SDK de Vercel AI) para generar y 
 * modificar código estructurado. Se apoya en esquemas de Zod para forzar a la IA a 
 * devolver JSON válidos y en validadores personalizados para asegurar la integridad del código.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import pMap from "p-map"; // Utilidad para procesar Promesas en paralelo con límite de concurrencia
import { FileCodeSchema, FilePlanSchema, RevisionResultSchema } from './aiSchemas.js';
import { buildFileCodeSystem, FILE_PLAN_SYSTEM, REVISE_SYSTEM } from './prompts.js';
import { normalizeContent } from './contentNormalizer.js';
import { validateAndFixCode, validateRevisionContent } from './codeValidator.js';

// --- Configuración del Cliente de IA (OpenRouter) ---
// Se toma el modelo de las variables de entorno o se usa un modelo gratuito por defecto.
const MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";
const MAX_CONCURRENCY = parseInt(process.env.AI_MAX_CONCURRENCY || "6", 10);

const openrouter = createOpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
});

const model = openrouter(MODEL);

/**
 * Genera el código fuente para un único archivo del proyecto.
 * 
 * @param {Object} file - Definición del archivo a generar (path, description, etc.).
 * @param {Array} allFiles - Planificación completa del proyecto (para dar contexto a la IA).
 * @param {string} prompt - Solicitud original del usuario.
 * @param {Object} alreadyGeneratedFiles - Archivos que ya se generaron correctamente en la sesión.
 * @returns {Promise<{path: string, code: string}>} - El objeto con la ruta y el código final.
 */
async function generateSingleFile(file, allFiles, prompt, alreadyGeneratedFiles) {
    // Construimos el "system prompt" inyectando el contexto de los archivos del proyecto
    const system = buildFileCodeSystem(allFiles, alreadyGeneratedFiles);

    const userMsg = `Project: ${prompt}\n\nWrite the complete code for: ${file.path}\nPurpose: ${file.description}`;

    console.log(`[AI] Creating file: ${file.path}...`);
    
    // Llamada a la IA forzando la salida al esquema Zod 'FileCodeSchema'
    const { object } = await generateObject({
        model,
        schema: FileCodeSchema,
        system,
        prompt: userMsg,
        maxRetries: 2, // Reintentos automáticos si la IA devuelve un JSON inválido
    });

    // Normalizamos el contenido (ej. limpiar saltos de línea extra, formatos extraños)
    let code = normalizeContent(object.code);

    if (code.trim().length === 0) {
        throw new Error("Generated code is empty after normalization");
    }

    // Validación post-generación: arregla errores comunes de sintaxis o imports faltantes
    const validation = validateAndFixCode(code, file.path, { allPlannedFiles: allFiles });
    code = validation.code;

    if (validation.warnings.length > 0) {
        console.log(`[Validator] Code adjustments for ${file.path}:\n  - ${validation.warnings.join("\n  - ")}`);
    }

    console.log(`[AI] Created file: ${file.path} (${code.length} chars)`);
    return { path: file.path, code };
}

/**
 * Orquestador principal: Genera un proyecto completo.
 * Consta de dos fases: Planificación de la estructura y Generación en paralelo.
 * 
 * @param {string} prompt - La idea o solicitud del proyecto.
 * @param {Object} callbacks - Callbacks opcionales para reportar progreso a la UI.
 * @returns {Promise<{files: Object, description: string}>}
 */
export async function generateProject(prompt, callbacks) {
    // --- FASE 1: Planificación de archivos ---
    console.log(`[AI] Phase 1: Planning file structure for: "${prompt.slice(0, 80)}..."`);
    const { object: plan } = await generateObject({
        model,
        schema: FilePlanSchema,
        system: FILE_PLAN_SYSTEM,
        prompt: `Plan a React website for: ${prompt}`,
        maxRetries: 2,
    });

    // Aseguramos que los archivos base críticos siempre existan en el plan
    if (!plan.files.find((f) => f.path === "/App.js")) {
        plan.files.unshift({
            path: "/App.js",
            description: "Main application entry point",
            exports: "default App",
            imports: ["./styles.css"],
        });
    }

    if (!plan.files.find((f) => f.path === "/styles.css")) {
        plan.files.push({
            path: "/styles.css",
            description: "Global CSS: Google Font import, keyframe animations, utility classes",
            exports: "none",
            imports: [],
        });
    }

    if (callbacks?.onPlan) {
        await callbacks.onPlan(plan);
    }

    // --- FASE 2: Generación concurrente ---
    console.log(`[AI] Phase 2: Generating ${plan.files.length} files in parallel (concurrency=${MAX_CONCURRENCY}): ${plan.files.map((f) => f.path).join(", ")}`);

    const files = {};
    let pendingFiles = plan.files.map((f) => ({ ...f })); // Copia para poder mutar la lista de pendientes
    const maxRetryRounds = 2; // Rondas extra para reintentar archivos que fallaron por errores de red o de la IA

    for (let round = 0; round <= maxRetryRounds; round++) {
        if (pendingFiles.length === 0) break;

        if (round > 0) {
            console.log(
                `[AI] Retry round ${round}/${maxRetryRounds} for ${pendingFiles.length} failed files: ${pendingFiles.map((f) => f.path).join(", ")}`,
            );
        }

        // Ejecutamos las promesas limitando cuántas corren al mismo tiempo (MAX_CONCURRENCY)
        const results = await pMap(
            pendingFiles,
            async (file) => {
                try {
                    if (callbacks?.onFileStart) await callbacks.onFileStart(file.path);

                    // Pasamos los 'files' ya generados para que la IA tenga contexto
                    const singleResult = await generateSingleFile(file, plan.files, prompt, files);

                    if (callbacks?.onFileComplete) await callbacks.onFileComplete(file.path, singleResult.code);
                    return { success: true, file, result: singleResult };
                } catch (err) {
                    return { success: false, file, error: err };
                }
            },
            { concurrency: MAX_CONCURRENCY },
        );

        // Clasificamos los resultados en exitosos y fallidos
        const failedFiles = [];
        for (const entry of results) {
            if (entry.success) {
                const { path, code } = entry.result;
                // Normalizamos la ruta para asegurar que siempre empiece con "/"
                const normalizedPath = path.startsWith("/") ? path : "/" + path;
                files[normalizedPath] = code;
            } else {
                console.warn(`[AI] File ${entry.file.path} failed in round ${round}: ${entry.error?.message || entry.error}`);
                failedFiles.push(entry.file);
            }
        }
        pendingFiles = failedFiles; // Los fallidos pasan a la siguiente ronda de reintentos
    }

    // --- Manejo de Fallbacks (Archivos que fallaron tras todos los reintentos) ---
    if (pendingFiles.length > 0) {
        const failedPaths = pendingFiles.map((f) => f.path).join(", ");
        console.error(`[AI] Failed to generate ${pendingFiles.length} files after all retry rounds: ${failedPaths}`);

        // [CORRECCIÓN DE BUG]: Iteramos sobre los archivos fallidos para crear un componente "Placeholder".
        // En tu código original, 'file' no estaba definido en este scope, lo que causaba un crash.
        for (const file of pendingFiles) {
            const ext = file.path.split(".").pop()?.toLowerCase();

            if (ext === "css") {
                files[file.path] = `/* ${file.description} — Generation failed, please retry */\n`;
            } else {
                files[file.path] = "import React from 'react';\n\n" +
                    `// ⚠️ This file could not be generated. Please retry.\n` +
                    `// Purpose: ${file.description}\n\n` +
                    "export default function Placeholder() {\n" +
                    "  return (\n" +
                    "    <div className='p-8 text-center text-zinc-400'>\n" +
                    "      <p>⚠️ Component failed to generate. Please try again.</p>\n" +
                    "    </div>\n" +
                    "  );\n" +
                    "}\n";
            }
        }
    }

    if (!files["/App.js"]) {
        throw new Error("AI did not generate /App.js entry point");
    }

    return { files, description: plan.projectDescription };
}

/**
 * Revisa y modifica un proyecto existente basado en un prompt de seguimiento.
 * Construye un contexto rico con el estado actual y devuelve operaciones (create, update, delete).
 * 
 * @param {string} prompt - Solicitud de modificación del usuario.
 * @param {Array} manifest - Lista de archivos actuales (hash, size, etc.).
 * @param {Object} relevantFiles - Contenido de los archivos que la IA necesita leer para hacer cambios.
 * @param {Array} recentMessages - Historial reciente del chat.
 * @returns {Promise<Object>} - Estructura con las operaciones a aplicar (rawParsed).
 */
export async function reviseProject(prompt, manifest, relevantFiles, recentMessages) {
    const contextParts = [];

    // 1. Inyectar el manifiesto del proyecto
    contextParts.push("## Current Project Files (manifest)");
    contextParts.push("```");
    for (const f of manifest) {
        contextParts.push(`${f.path} (${f.hash}, ${f.size}B)`);
    }
    contextParts.push("```");

    // 2. Inyectar contenido de archivos relevantes
    if (Object.keys(relevantFiles).length > 0) {
        contextParts.push("\n## File Contents (for reference)");
        for (const [path, content] of Object.entries(relevantFiles)) {
            contextParts.push(`\n### ${path}\n\`\`\`\n${content}\n\`\`\``);
        }
    }

    // 3. Inyectar historial de conversación
    if (recentMessages.length > 0) {
        contextParts.push("\n## Recent Conversation");
        for (const msg of recentMessages.slice(-3)) {
            contextParts.push(`${msg.role}: ${msg.content}`);
        }
    }

    contextParts.push(`\n## Revision Request\n${prompt}`);

    console.log("[AI] Revising project...");

    const { object: rawParsed } = await generateObject({
        model,
        schema: RevisionResultSchema,
        system: REVISE_SYSTEM,
        prompt: contextParts.join("\n"),
        maxRetries: 2
    });

    // Post-procesamiento y normalización de las operaciones devueltas por la IA
    if (rawParsed && Array.isArray(rawParsed.operations)) {
        rawParsed.operations = rawParsed.operations.map((op) => {
            if (!op || typeof op !== "object") return op;

            // Unificamos los verbos de la IA a nuestras operaciones estándar
            let opStr = String(op.op || "").trim().toLowerCase();

            if (["create", "add", "new"].includes(opStr)) op.op = "create";
            else if (["update", "edit", "modify", "patch"].includes(opStr)) op.op = "update";
            else if (["delete", "remove", "del", "rm"].includes(opStr)) op.op = "delete";

            // Normalizamos las rutas para asegurar que empiezan con "/"
            if (op.path && typeof op.path === "string" && !op.path.startsWith("/")) {
                op.path = "/" + op.path;
            }

            // Limpiamos y validamos el contenido dependiendo de la operación
            if (op.content) op.content = normalizeContent(op.content);
            if (op.search) op.search = normalizeContent(op.search);
            if (op.replace) op.replace = normalizeContent(op.replace);

            if (op.op === "create" && op.content) {
                const validation = validateRevisionContent(op.content, op.path, "create");
                op.content = validation.content;
                if (validation.warnings.length > 0) {
                    console.log(`[Validator] Revision Create adjustments for ${op.path}:\n  - ${validation.warnings.join("\n  - ")}`);
                }
            } else if (op.op === "update" && op.replace) {
                const validation = validateRevisionContent(op.replace, op.path, "update");
                op.replace = validation.content;
                if (validation.warnings.length > 0) {
                    console.log(`[Validator] Revision Update adjustments for ${op.path}:\n  - ${validation.warnings.join("\n  - ")}`);
                }
            }
            return op;
        });
    }
    return rawParsed;
}

// GenerateObject aparece como deprecate. 
// Vamos a usar generateText() y a parsear el contenido

/**
 * Módulo de Generación y Revisión de Proyectos con IA.
 * 
 * Este orquestador utiliza OpenRouter (a través del SDK de Vercel AI) para generar y 
 * modificar código estructurado. Se apoya en esquemas de Zod para forzar a la IA a 
 * devolver JSON válidos y en validadores personalizados para asegurar la integridad del código.
 * 
 * NOTA DE VERSIÓN: En AI SDK v5/v6, `generateObject` fue deprecado. 
 * Ahora se utiliza `generateText` junto con `Output.object()` para datos estructurados.
 */

//import { createOpenAI } from '@ai-sdk/openai';
// Importamos generateText y Output en lugar de generateObject
//import { generateText, Output } from 'ai'; 
//import pMap from "p-map"; 
//import { FileCodeSchema, FilePlanSchema, RevisionResultSchema } from './aiSchemas.js';
//import { buildFileCodeSystem, FILE_PLAN_SYSTEM, REVISE_SYSTEM } from './prompts.js';
//import { normalizeContent } from './contentNormalizer.js';
//import { validateAndFixCode, validateRevisionContent } from './codeValidator.js';

// --- Configuración del Cliente de IA (OpenRouter) ---
//const MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";
//const MAX_CONCURRENCY = parseInt(process.env.AI_MAX_CONCURRENCY || "6", 10);

//const openrouter = createOpenAI({
//    baseURL: "https://openrouter.ai/api/v1",
//    apiKey: process.env.OPENROUTER_API_KEY,
//});

//const model = openrouter(MODEL);

/**
 * Genera el código fuente para un único archivo del proyecto.
 */
//async function generateSingleFile(file, allFiles, prompt, alreadyGeneratedFiles) {
//    const system = buildFileCodeSystem(allFiles, alreadyGeneratedFiles);

//    const userMsg = `Project: ${prompt}\n\nWrite the complete code for: ${file.path}\nPurpose: ${file.description}`;

//    console.log(`[AI] Creating file: ${file.path}...`);
    
    // MIGRACIÓN: Usamos generateText + Output.object
//    const { output } = await generateText({
//        model,
//        system,
//        prompt: userMsg,
//        maxRetries: 2,
//        output: Output.object({ schema: FileCodeSchema }),
//    });

    // Ahora accedemos a 'output' en lugar de 'object'
//    let code = normalizeContent(output.code);

//    if (code.trim().length === 0) {
//        throw new Error("Generated code is empty after normalization");
//    }

//    const validation = validateAndFixCode(code, file.path, { allPlannedFiles: allFiles });
//    code = validation.code;

//    if (validation.warnings.length > 0) {
//        console.log(`[Validator] Code adjustments for ${file.path}:\n  - ${validation.warnings.join("\n  - ")}`);
//    }

//    console.log(`[AI] Created file: ${file.path} (${code.length} chars)`);
//    return { path: file.path, code };
//}

/**
 * Orquestador principal: Genera un proyecto completo.
 */
//export async function generateProject(prompt, callbacks) {
    // --- FASE 1: Planificación de archivos ---
//    console.log(`[AI] Phase 1: Planning file structure for: "${prompt.slice(0, 80)}..."`);
    
//    const { output: plan } = await generateText({
//        model,
//        system: FILE_PLAN_SYSTEM,
//        prompt: `Plan a React website for: ${prompt}`,
//        maxRetries: 2,
//        output: Output.object({ schema: FilePlanSchema }),
//    });

//    if (!plan.files.find((f) => f.path === "/App.js")) {
//        plan.files.unshift({
//            path: "/App.js",
//            description: "Main application entry point",
//            exports: "default App",
//            imports: ["./styles.css"],
//        });
//    }

//    if (!plan.files.find((f) => f.path === "/styles.css")) {
//        plan.files.push({
//            path: "/styles.css",
//            description: "Global CSS: Google Font import, keyframe animations, utility classes",
//            exports: "none",
//            imports: [],
//        });
//    }

//    if (callbacks?.onPlan) {
//        await callbacks.onPlan(plan);
//    }

    // --- FASE 2: Generación concurrente ---
//    console.log(`[AI] Phase 2: Generating ${plan.files.length} files in parallel (concurrency=${MAX_CONCURRENCY}): ${plan.files.map((f) => f.path).join(", ")}`);

//    const files = {};
//    let pendingFiles = plan.files.map((f) => ({ ...f }));
//    const maxRetryRounds = 2;

//    for (let round = 0; round <= maxRetryRounds; round++) {
//        if (pendingFiles.length === 0) break;

//        if (round > 0) {
//            console.log(
//                `[AI] Retry round ${round}/${maxRetryRounds} for ${pendingFiles.length} failed files: ${pendingFiles.map((f) => f.path).join(", ")}`,
//            );
//        }

//        const results = await pMap(
//            pendingFiles,
//            async (file) => {
//                try {
//                    if (callbacks?.onFileStart) await callbacks.onFileStart(file.path);
//                    const singleResult = await generateSingleFile(file, plan.files, prompt, files);
//                    if (callbacks?.onFileComplete) await callbacks.onFileComplete(file.path, singleResult.code);
//                    return { success: true, file, result: singleResult };
//                } catch (err) {
//                    return { success: false, file, error: err };
//                }
//            },
//            { concurrency: MAX_CONCURRENCY },
//        );

//        const failedFiles = [];
//        for (const entry of results) {
//            if (entry.success) {
//                const { path, code } = entry.result;
//                const normalizedPath = path.startsWith("/") ? path : "/" + path;
//                files[normalizedPath] = code;
//            } else {
//                console.warn(`[AI] File ${entry.file.path} failed in round ${round}: ${entry.error?.message || entry.error}`);
//                failedFiles.push(entry.file);
//            }
//        }
//        pendingFiles = failedFiles;
//    }

    // --- Manejo de Fallbacks ---
//    if (pendingFiles.length > 0) {
//        const failedPaths = pendingFiles.map((f) => f.path).join(", ");
//        console.error(`[AI] Failed to generate ${pendingFiles.length} files after all retry rounds: ${failedPaths}`);

        // [CORRECCIÓN DE BUG]: Iteramos correctamente sobre los archivos fallidos.
//        for (const file of pendingFiles) {
//            const ext = file.path.split(".").pop()?.toLowerCase();

//            if (ext === "css") {
//                files[file.path] = `/* ${file.description} — Generation failed, please retry */\n`;
//            } else {
//                files[file.path] = "import React from 'react';\n\n" +
//                    `// ⚠️ This file could not be generated. Please retry.\n` +
//                    `// Purpose: ${file.description}\n\n` +
//                    "export default function Placeholder() {\n" +
//                    "  return (\n" +
//                    "    <div className='p-8 text-center text-zinc-400'>\n" +
//                    "      <p>⚠️ Component failed to generate. Please try again.</p>\n" +
//                    "    </div>\n" +
//                    "  );\n" +
//                    "}\n";
//            }
//        }
//    }

//    if (!files["/App.js"]) {
//        throw new Error("AI did not generate /App.js entry point");
//    }

//    return { files, description: plan.projectDescription };
//}

/**
 * Revisa y modifica un proyecto existente basado en un prompt de seguimiento.
 */
//export async function reviseProject(prompt, manifest, relevantFiles, recentMessages) {
//    const contextParts = [];

//    contextParts.push("## Current Project Files (manifest)");
//    contextParts.push("```");
//    for (const f of manifest) {
//        contextParts.push(`${f.path} (${f.hash}, ${f.size}B)`);
//    }
//    contextParts.push("```");

//    if (Object.keys(relevantFiles).length > 0) {
//        contextParts.push("\n## File Contents (for reference)");
//        for (const [path, content] of Object.entries(relevantFiles)) {
//            contextParts.push(`\n### ${path}\n\`\`\`\n${content}\n\`\`\``);
//        }
//    }

//    if (recentMessages.length > 0) {
//        contextParts.push("\n## Recent Conversation");
//        for (const msg of recentMessages.slice(-3)) {
//            contextParts.push(`${msg.role}: ${msg.content}`);
//        }
//    }

//    contextParts.push(`\n## Revision Request\n${prompt}`);

//    console.log("[AI] Revising project...");

//    const { output: rawParsed } = await generateText({
//        model,
//        system: REVISE_SYSTEM,
//        prompt: contextParts.join("\n"),
//        maxRetries: 2,
//        output: Output.object({ schema: RevisionResultSchema }),
//    });

//    if (rawParsed && Array.isArray(rawParsed.operations)) {
//        rawParsed.operations = rawParsed.operations.map((op) => {
//            if (!op || typeof op !== "object") return op;

//            let opStr = String(op.op || "").trim().toLowerCase();

//            if (["create", "add", "new"].includes(opStr)) op.op = "create";
//            else if (["update", "edit", "modify", "patch"].includes(opStr)) op.op = "update";
//            else if (["delete", "remove", "del", "rm"].includes(opStr)) op.op = "delete";

//            if (op.path && typeof op.path === "string" && !op.path.startsWith("/")) {
//                op.path = "/" + op.path;
//            }

//            if (op.content) op.content = normalizeContent(op.content);
//            if (op.search) op.search = normalizeContent(op.search);
//            if (op.replace) op.replace = normalizeContent(op.replace);

//            if (op.op === "create" && op.content) {
//                const validation = validateRevisionContent(op.content, op.path, "create");
//                op.content = validation.content;
//                if (validation.warnings.length > 0) {
//                    console.log(`[Validator] Revision Create adjustments for ${op.path}:\n  - ${validation.warnings.join("\n  - ")}`);
//                }
//            } else if (op.op === "update" && op.replace) {
//                const validation = validateRevisionContent(op.replace, op.path, "update");
//                op.replace = validation.content;
//                if (validation.warnings.length > 0) {
//                    console.log(`[Validator] Revision Update adjustments for ${op.path}:\n  - ${validation.warnings.join("\n  - ")}`);
//                }
//            }
//            return op;
//        });
//    }
//    return rawParsed;
//}