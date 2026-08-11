import { Project } from "../models/Projects.js"
import crypto from "crypto"
import { generateProject } from "../services/ai.js";

function hashContent(content) {
  return crypto.createHash("md5").update(content).digest("hex").slice(0, 12)
}


// POST /api/projects
// Create a new project from an AI prompt.
export async function createProject(req, res) {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ message: 'Prompt is required' });
  }

  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  // Create project in DB inmmediately with "pending" status
  const project = await Project.create({
    name: "Planning project...",
    description: prompt,
    files: {},
    messages: [
      {
        role: "user",
        content: prompt
      },
      {
        role: "assistant",
        content: "Planning project structure..."
      }
    ],
    version: 0,
    owner: req.user.userId,
    status: "pending",
    filesPlanned: [],
    filesGenerated: [],
    currentFile: null,
    error: null,
  });

  // Start background generation
  runBackgroundGeneration(project._id.toString(), prompt)
    .catch(error => {
      console.error(`[Background AI] Fatal generation error for project ${project._id}`, error);
    })

  res.status(201).json({
    message: 'Project created successfully',
    project: {
      _id: project._id,
      name: project.name,
      description: project.description,
      files: {},
      messages: project.messages,
      version: project.version,
      status: project.status,
      filesPlanned: project.filesPlanned,
      filesGenerated: project.filesGenerated,
      currentFile: project.currentFile,
      error: project.error,
      createdAt: project.createdAt,
    }
  });
}

/**
 * Worker en segundo plano que orquesta la generación progresiva de un proyecto.
 * Actúa como puente entre el generador de IA y la base de datos, persistiendo
 * el estado en tiempo real para que el frontend pueda mostrar progreso.
 * 
 * @param {string} projectId - ID del documento en MongoDB
 * @param {string} prompt - Solicitud del usuario para generar el proyecto
 */

// ai.js (generateProject)          runBackgroundGeneration (controller)
// ─────────────────────            ─────────────────────────────────────
// Fase 1: IA genera plan    ───►   onPlan(plan)        → Guarda estructura en BD
// Fase 2: Archivo inicia    ───►   onFileStart(path)   → Actualiza indicador UI
// Fase 2: Archivo termina   ───►   onFileComplete(p,c) → Persiste código + hash
// Fin: Todo OK              ───►   (retorno de result) → Marca status "completed"
// Error: Algo falló         ───►   (catch del try)     → Marca status "failed"

async function runBackgroundGeneration(projectId, prompt) {
  try {
    console.log(`[Background AI] Starting generation for project ${projectId}`);

    // Se invoca generateProject inyectando callbacks que persisten cada evento en BD.
    // Esto permite que el frontend haga polling/escuche cambios sin esperar al final.
    const result = await generateProject(prompt, {

      /**
       * FASE 1: El plan está listo.
       * Actualiza el proyecto con la estructura planeada y cambia el estado a "generating".
       * Usa $push para añadir un mensaje al historial de chat de forma atómica.
       */
      onPlan: async (plan) => {
        console.log(`[Background AI] Plan created for project ${projectId}. Planned ${plan.files.length} files`);
        const fileList = plan.files.map((f) => `- \`${f.path}\`: ${f.description}`).join("\n"); // Formato de lista para el mensaje de chat

        await Project.findByIdAndUpdate(projectId, {       // Actualiza el proyecto con la estructura planeada y cambia el estado a "generating". Usa $push para añadir un mensaje al historial de chat de forma atómica.
          name: plan.projectName || "Generated Project",
          status: "generating",
          filesPlanned: plan.files,
          $push: {
            messages: {
              role: "assistant",
              content: `Planned website structure:\n${fileList}`,
              timestamp: new Date(),
            }
          }
        });
      },

      /**
       * FASE 2a: Un archivo empieza a generarse.
       * Solo actualiza currentFile para que la UI muestre qué se está procesando.
       * Operación ligera intencionalmente para no saturar la BD durante alta concurrencia.
       */
      onFileStart: async (path) => {
        console.log(`[Background AI] Starting file ${path} for project ${projectId}`);
        await Project.findByIdAndUpdate(projectId, {
          currentFile: path,
        });
      },

      /**
       * FASE 2b: Un archivo se generó exitosamente.
       * IMPORTANTE: Usa findById + save() en lugar de findByIdAndUpdate porque
       * necesita leer-actualizar-escribir el objeto 'files' (que es dinámico)
       * y el array 'filesGenerated'. markModified() fuerza a Mongoose a detectar
       * cambios en objetos anidados tipo Mixed/Object.
       */
      onFileComplete: async (path, code) => {
        console.log(`[Background AI] Finished file ${path} for project ${projectId}`);
        const project = await Project.findById(projectId); // Busca el documento en BD

        if (project) {                                                        // Si el proyecto existe
          project.files = project.files || {};                                // project.files se inicializa si es null o undefined. En MongoDB, un documento nuevo no tiene campos hasta que se escriben. 
          project.files[path] = { content: code, hash: hashContent(code) };   // Se añade el archivo al objeto files
          project.filesGenerated = [...(project.filesGenerated || []), path]; // Se añade el archivo al array filesGenerated
          project.messages.push({
            role: "assistant",
            content: `Created file "${path}"`,
            timestamp: new Date(),
          });
          project.currentFile = null;

          // Necesario cuando se modifican propiedades dinámicas en esquemas Mongoose
          // Mongoose es estricto con los cambios en campos "Mixed" (como 'files').
          // Sin markModified("files"), Mongoose podría pensar que el objeto no cambió y no guardar nada.
          project.markModified("files");
          await project.save();
        }
      }
    });

    // --- FINALIZACIÓN EXITOSA ---
    // Marca el proyecto como completado y establece versión inicial.
    console.log(`[Background AI] Successfully generated for project ${projectId}`);
    const project = await Project.findById(projectId);
    if (project) {
      project.status = "completed";
      project.version = 1;
      if (result.description) {
        project.name = result.description;
      }
      project.messages.push({
        role: "assistant",
        content: "Website generation complete! You can view and edit the files.",
        timestamp: new Date(),
      });
      await project.save();
    }

  } catch (err) {
    // --- MANEJO DE ERRORES GLOBALES ---
    // Si algo falla de forma no recuperable, marca el proyecto como "failed"
    // y persiste el error en el historial de mensajes para que el usuario lo vea.
    console.log(`[Background AI] Generation failed for project ${projectId}:`, err);
    await Project.findByIdAndUpdate(projectId, {
      status: "failed",
      error: err.message,
      $push: {
        messages: {
          role: "assistant",
          content: `Generation failed: ${err.message}.`,
          timestamp: new Date(),
        }
      }
    });
  }
}

// GET /api/projects
// List all projects owned by the user (Summary only, no files content)
export async function listProjects(req, res) {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const projects = await Project.find(
    { owner: req.user.userId },
    { name: 1, description: 1, version: 1, createdAt: 1, updatedAt: 1 }
  ).sort({ updatedAt: -1 });

  res.json(projects);
}

// GET /api/projects/:id
// Get full project details
export async function getProject(req, res) {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const project = await Project.findOne({
    _id: req.params.id,
    owner: req.user.userId,
  });

  if (!project) {
    return res.status(404).json({ message: 'Project not found' });
  }

  const filesObj = {};
  for (const [path, entry] of Object.entries(project.files)) { // create files object with only content
    filesObj[path] = entry.content;
  }

  res.json({
    _id: project._id,
    name: project.name,
    description: project.description,
    files: filesObj,
    messages: project.messages,
    version: project.version,
    status: project.status,
    filesPlanned: project.filesPlanned,
    filesGenerated: project.filesGenerated,
    currentFile: project.currentFile,
    error: project.error,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  });
}

// DELETE /api/projects/:id
// Delete a project 
export async function deleteProject(req, res) {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const result = await Project.findOneAndDelete({
    _id: req.params.id,
    owner: req.user.userId,
  });

  if (!result) {
    return res.status(404).json({ message: 'Project not found' });
  }

  res.json({ success: true });
}

// PUT /api/projects/:id/files
// Update project files (manual edits)
export async function updateProjectFiles(req, res) {
  const files = req.body;
  if (!files || typeof files !== "object") {
    res.status(400).json({ error: "files object is required" })
    return
  }

  if (!req.user) {
    res.status(401).json({ message: "Unauthorized" })
    return
  }

  const project = await Project.findOne({
    _id: req.params.id,
    owner: req.user.userId,
  })

  if (!project) {
    return res.status(404).json({ message: 'Project not found' });
  }

  // Rebuild project files
  const newFiles = {};
  for (const [path, content] of Object.entries(files)) { // Creamos un nuevo objeto con los archivos y su hash {path: {content, hash}}
    if (typeof content === "string") {
      newFiles[path] = { content, hash: hashContent(content) }
    }
  }
  project.files = newFiles;
  await project.save(); // Actualizamos el proyecto en la base de datos                                           

  const filesObj = {};
  for (const [path, entry] of Object.entries(project.files)) { //{path: contenido} sin el hash 
    if (typeof entry.content === "string") {
      filesObj[path] = entry.content;
    }
  }

  res.json({
    _id: project._id,
    name: project.name,
    description: project.description,
    files: filesObj,
    messages: project.messages,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  })

}

// POST /api/projects/:id/publish
// Mark a project as publicy published
export async function publishProject(req, res) {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const project = await Project.findOneAndUpdate(
    { _id: req.params.id, owner: req.user.userId },
    { status: "published" },
    { returnDocument: "after" }
  );

  if (!project) {
    return res.status(404).json({ message: "Project not found" });
  }

  res.json({ success: true, published: project.published });
}

// GET /api/projects/oublic/:id
// Get a publicy published project details (without auth)
export async function getPublicProject(req, res) {
  const project = await Project.findById(req.params.id)
  if (!project) {
    res.status(404).json({ message: "Project not found" });
    return;
  }

  if (!project.published) {
    res.status(403).json({ message: "Project is not published yet." });
    return;
  }

  const filesObj = {};
  for (const [path, entry] of Object.entries(project.files)) { // creamos un nuevo objeto con solo el contenido 
    filesObj[path] = entry.content;
  }

  res.json({
    _id: project._id,
    name: project.name,
    description: project.description,
    files: filesObj,
    version: project.version,
  })
}