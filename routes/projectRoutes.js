

import { Router } from "express";
import {
    createProject,
    listProjects,
    getProject,
    deleteProject,
    updateProjectFiles,
    publishProject,
    getPublicProject
} from "../controllers/projectController.js";

import { chat } from "../controllers/chatController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const projectRouter = Router();

//Public routes
projectRouter.get("/public/:id", getPublicProject);


//Authenticated user routes

projectRouter.use(authMiddleware);

projectRouter.post("/", createProject);
projectRouter.get("/", listProjects);
projectRouter.get("/:id", getProject);
projectRouter.delete("/:id", deleteProject);
projectRouter.put("/:id/files", updateProjectFiles);
projectRouter.post("/:id/publish", publishProject);

// Chat
projectRouter.post("/:id/chat", chat)



export default projectRouter;