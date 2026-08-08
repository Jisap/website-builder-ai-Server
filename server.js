import express from "express";
import "dotenv/config";
import cors from "cors";
import cookieParser from "cookie-parser";

const app = express();

app.use(cors({ origin: process.env.ORIGINS.split(','), credentials: true }))
app.use(express.json)
