

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
import { authMiddleware } from "../middleware/auth.js";

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



export default projectRouter;