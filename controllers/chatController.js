import { json } from "zod";
import { Project } from "../models/Projects.js";
import { reviseProject } from "../services/ai";
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
export async function chat(req, es) {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "prompt is required" })
    return
  }

  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const project = await Project.findOne({
    _id: req.params.id,
    owner: req.user.userId,
  });

  if (!project) {
    res.status(404).json({ error: "Project not found" })
    return
  }

  // Set status to revising and save user prompt inmmediatly
  project.status = "revising"
  project.messages.push({
    role: "user",
    content: prompt,
    timestamp: Date.now(),
  });
  await project.save()

  try {
    // Build compact manifest (path + hash + size) instead of sending all code
    const manifest = buildManifest(project.files)

    // Include all file contents so the AI can do accurate search/replace
    const relevantFiles = {};
    for (const [path, entry] of Object.entries(project.files)) {
      relevantFiles[path] = entry.content
    }

    // Recent messages for context (last 4 max)
    const recentMessages = project.messages.slice(-4).map((m) => ({
      role: m.role,
      content: m.content
    }))

    console.log(
      `[AI] Revising project ${project._id}: "${prompt.slice(0, 80)}...` +
      `(${manifest.length} files, manifest - ${json.stringify(manifest).length} chars)`
    )

    // Call AI with manifest + relevant files.
    const result = await reviseProject(
      prompt,
      manifest,
      recentMessages,
      relevantFiles
    )

    console.log(`[AI] Got ${result.operations.length} operations: ${result.description}`);

    // Apply operation to file map
    const { files: updatedFiles, applied, errors } = applyOperations(project.files, result.operations);

    if (errors.length > 0) {
      console.warn(`[Diff] Errors applying operations:`, errors);
    }

    //update project in DB
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

    // Return updated project
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