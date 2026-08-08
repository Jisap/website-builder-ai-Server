import mongoose from "mongoose";

export async function connectToDatabase() {
    mongoose.connection.on("connected", () => {
        console.log("MongoDB connected successfully");
    })
    await mongoose.connect(process.env.MONGODB_URI)

}