import { z } from "zod";

/**
 * 📦 GenerationResultSchema
 * 
 * Relevancia: Representa el "paquete" final del proyecto. 
 * Aunque se construye el objeto `{files, description}` manualmente 
 * al final de `generateProject`, este esquema es ideal para validar el resultado 
 * final antes de enviarlo al frontend o guardarlo en base de datos.
 */
export const GenerationResultSchema = z.object({
    // z.record crea un diccionario (clave-valor). 
    // Clave: Ruta del archivo (ej. "/App.js"). Valor: Código fuente en string.
    files: z.record(z.string(), z.string()),
    description: z.string().default('Generated project') // El .default() evita errores si la IA omite el campo.
});

/**
 * 🛠️ FileOpSchema (File Operation Schema)
 * 
 * Relevancia: Es el núcleo del sistema de edición quirúrgica en `reviseProject`.
 * Permite a la IA decidir cómo modificar el proyecto existente sin tener que 
 * reescribir todo el código desde cero.
 */
export const FileOpSchema = z.object({
    // El ENUM es crucial: fuerza a la IA a categorizar su intención en una de estas 3 opciones.
    // En tu código de revisión, mapeas sinónimos (add, edit, rm) a estos valores base.
    op: z.enum(["create", "update", "delete"]),

    // Ruta del archivo objetivo.
    path: z.string(),

    // 'content': Usado en 'create' (para el nuevo archivo) o en 'update' (para reescribir todo).
    // Es nullable().optional() porque NO aplica para 'delete' ni para ediciones parciales.
    content: z.string().nullable().optional(),

    // 'search' y 'replace': El patrón de "Búsqueda y Reemplazo".
    // Permite a la IA hacer ediciones precisas en 'update' (ej. cambiar solo una función 
    // dentro de un archivo de 500 líneas) en lugar de regenerar todo el archivo.
    search: z.string().nullable().optional(),
    replace: z.string().nullable().optional(),
});

/**
 * 🔄 RevisionResultSchema
 * 
 * Relevancia: Es la salida directa de `reviseProject`. 
 * Agrupa en un array todas las operaciones (FileOpSchema) que la IA ha decidido 
 * aplicar como respuesta al prompt del usuario.
 */
export const RevisionResultSchema = z.object({
    operations: z.array(FileOpSchema),
    description: z.string().default('Applied revisions')
});

/**
 * 🗺️ FilePlanSchema (El Arquitecto)
 * 
 * Relevancia: Es la salida de la FASE 1 de `generateProject`. 
 * Antes de escribir código, la IA actúa como arquitecto y diseña la topología del proyecto.
 * Los campos `exports` e `imports` son vitales para que, en la FASE 2, la IA sepa 
 * qué dependencias inyectar cuando genere cada archivo individualmente.
 */
export const FilePlanSchema = z.object({
    files: z.array(
        z.object({
            path: z.string(), // ej. "/components/Header.jsx"
            description: z.string(), // El "propósito" que se inyecta en el prompt de generateSingleFile
            exports: z.string().optional().default(""), // ej. "default Header"
            imports: z.array(z.string()).optional().default([]), // ej. ["./styles.css"]
        })
    ),
    projectName: z.string().default('Generated Project'),
    projectDescription: z.string().default('A React project')
});

/**
 * 🧱 FileCodeSchema (El Constructor)
 * 
 * Relevancia: Es la salida de `generateSingleFile`. 
 * Es un esquema minimalista diseñado para extraer únicamente el bloque de código.
 * Al ser tan simple, la carga de validar que el código sea sintácticamente correcto 
 * o tenga los imports adecuados se delega a tu función `validateAndFixCode()`.
 */
export const FileCodeSchema = z.object({
    code: z.string(),
});