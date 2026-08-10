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
    ownerId: req.user.userId,
    status: "pending",
    filesPlanned: [],
    filesGenerated: [],
    currentFile: [],
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

// Background worker to progressive generate files and update database in real-time
async function runBackgroundGeneration(projectId, prompt) {
  try {
    console.log(`[Background AI] Starting generation for project ${projectId}`);

    const result = await generateProject(prompt, {
      onPlan: async (plan) => {
        console.log(`[Background AI] Plan created for project ${projectId}. Planned ${plan.files.length} files`);
        const fileList = plan.files.map((f) => `- \`${f.path}\`: ${f.description}`).join("\n");

        await Project.findByIdAndUpdate(projectId, {
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
        })
      },
      onFileStart: async (path) => {
        console.log(`[Background AI] Starting file ${path} for project ${projectId}`)
        await Project.findByIdAndUpdate(projectId, {
          currentFile: path,
        })
      },
      onFileComplete: async (patt, code) => {
        console.log(`[Background AI] Finished file ${path} for project ${projectId}`)
        const project = await Project.findById(projectId);

        if (project) {
          project.files = project.files || {};
          project.files[path] = { content: code, hash: hashContent(code) };
          project.filesGenerated = [...(project.filesGenerated || []), path]
          project.messages.push({
            role: "assistant",
            content: `Created file "${path}"`,
            timestamp: new Date(),
          })
          project.currentFile = null;
          project.markModified("files");
          await project.save();
        }
      }
    })

    console.log(`[Background AI] Successfully generated for project ${projectId}`);
    const project = await Project.findById(projectId);
    if (project) {
      project.status = "completed";
      project.version = 1;
      if (result.description) {
        project.name = result.description
      }
      project.messages.push({
        role: "assistant",
        content: "Website generation complete! You can view and edit the files.",
        timestamp: new Date(),
      })

      await project.save();
    }

  } catch (err) {
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
    })

  }
}

// GET /api/projects
// List all projects owned by the user (Summary only, no files content)
export async function listProjects(req, res) {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const projects = await Project.find(
    { ownerId: req.user.userId },
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
    ownerId: req.user.userId,
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
    ownerId: req.user.userId,
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
    ownerId: req.user.userId,
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
    { _id: req.params.id, ownerId: req.user.userId },
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
  const project = await project.findByid(req.params.id)
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