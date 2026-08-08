import { Schema, model } from "mongoose"
import bcrypt from "bcrypt"

const UserSchema = new Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
}, { timestamps: true })

// Hashea la contraseña antes de guardar
UserSchema.pre('save', async function (next) {
    if (!this.isModified('password')) return next();
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt); // this.password = "version del alogaritmo bcrypt + num de rondas + salt (codigo aleatorio) + hash de la contraseña (encryptacion de la password)
    next();
})

// Compara la contraseña
UserSchema.methods.comparePassword = async function (password) { // comparePassword recibe la pass en texto plano, extrae el hash de this.password usando la misma salt -> compara el hast extraido con el guardado
    return await bcrypt.compare(password, this.password);        // Si coinciden devuelve true, si no false
}

export const User = model('User', UserSchema);