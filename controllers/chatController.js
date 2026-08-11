//import { json } from "zod";
import { Project } from "../models/Projects.js";
import { reviseProject } from "../services/ai.js";

import { applyOperations } from "../services/diff.js";


// Helper: generar manifiesto compacto (ruta + hash + tamaño) 
// en lugar de enviar todo el código
export function buildManifest(files) {
  const manifest = [];
  for (const [path, entry] of Object.entries(files)) {
    manifest.push({
      path,
      hash: entry.hash,
      size: entry.content.length
    })
  }
  return manifest
}

// POST /api/projects/:id/chat
// Send a revision prompt and return updated project.
export async function chat(req, res) {
  const { prompt } = req.body;

  // Comprueba que venga un prompt válido y que el usuario esté autenticado.
  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "prompt is required" })
    return
  }

  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Busca el proyecto asociado a ese usuario. Si no existe, devuelve error 404.
  const project = await Project.findOne({
    _id: req.params.id,
    owner: req.user.userId,
  });

  if (!project) {
    res.status(404).json({ error: "Project not found" })
    return
  }

  // Guarda el mensaje del usuario de inmediato.
  // Se hace fuera del try, para que si algo falla después, quede constancia de que el usuario pidió 
  // el cambio y el proyecto se marque como "revising".
  project.status = "revising"
  project.messages.push({
    role: "user",
    content: prompt,
    timestamp: Date.now(),
  });
  await project.save()

  // Se prepara el contexto para la IA
  try {
    // manifest Genera un resumen liviano de cada archivo (ruta, hash, tamaño), sin el contenido completo.
    const manifest = buildManifest(project.files)

    // En cambio relevantFiles, este sí manda el contenido completo de todos los archivos 
    // para que la IA pueda hacer "search/replace" preciso.
    const relevantFiles = {};
    for (const [path, entry] of Object.entries(project.files)) {
      relevantFiles[path] = entry.content
    }

    // recentMessages son los últimos 4 mensajes del historial, para darle contexto conversacional a la IA.
    const recentMessages = project.messages.slice(-4).map((m) => ({
      role: m.role,
      content: m.content
    }))

    console.log(
      `[AI] Revising project ${project._id}: "${prompt.slice(0, 80)}...` +
      `(${manifest.length} files, manifest - ${JSON.stringify(manifest).length} chars)`
    )

    // Llama a la AI pasándole el prompt, el manifiesto, el historial y los archivos.
    // Esta devuelve un result con una lista de operations (qué cambios hacer) y una description.
    const result = await reviseProject(
      prompt,
      manifest,
      relevantFiles,
      recentMessages
    );

    console.log(`[AI] Got ${result.operations.length} operations: ${result.description}`);

    // Aplica los cambios con applyOperations, que toma los archivos originales y las operaciones, 
    // y devuelve los archivos actualizados más una lista de errores si alguna operación falló.
    const { files: updatedFiles, applied, errors } = applyOperations(project.files, result.operations);

    if (errors.length > 0) {
      console.warn(`[Diff] Errors applying operations:`, errors);
    }

    // Guarda todo 
    // - archivos nuevos, 
    // - versión incrementada, 
    // - estado "completed", 
    // - y un mensaje del asistente con la descripción (y los errores, si los hubo).
    project.files = updatedFiles;
    project.markModified("files");
    project.version += 1;
    project.status = "completed";
    project.messages.push({
      role: "assistant",
      content: result.description + (errors.length > 0 ? `\n\n Some operations failed: ${errors.join(", ")}` : ""),
      timestamp: Date.now()
    });
    await project.save();

    // Devuelve el proyecto actualizado, con el mapa de archivos plano (sin el hash) 
    // para facilitar el uso en el frontend.
    const filesObj = {};
    for (const [path, entry] of Object.entries(project.files)) {
      filesObj[path] = entry.content
    }

    res.json({
      _id: project._id,
      name: project.name,
      description: project.description,
      files: filesObj,
      messages: project.messages,
      version: project.version,
      status: project.status,
      applied,
      errors,
      aiDescription: result.description,
    })

  } catch (err) {
    console.error(`[AI Revision Error] ${err.message}`);
    project.status = "completed";
    await project.save()
    res.status(500).json({
      error: err.message || "Failed to process revision request"
    })
  }


}