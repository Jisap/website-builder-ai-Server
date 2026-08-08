import jwt from "jsonwebtoken";
import { User } from "../models/User";

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET no está definido en las variables de entorno")
}

const setSessionCookie = (res, payload) => {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" })

  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/"
  })
}

export async function register(req, res) {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Todos los campos son obligatorios" });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres" });
  }

  try {
    const trimmedEmail = email.toLowerCase().trim();
    const existing = await User.findOne({ email: trimmedEmail })
    if (existing) {
      return res.status(400).json({ error: "El usuario ya existe" });
    }

    const newUser = await User.create({
      name,
      email: trimmedEmail,
      password
    });

    setSessionCookie(
      res,
      {
        userId: newUser._id.toString(),
        email: newUser.email,
      }
    )

    res.status(201).json({
      user: {
        _id: newUser._id,
        name: newUser.name,
        email: newUser.email
      }
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: "El usuario ya existe" });
    }
    console.error("Error al registrar el usuario:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
}


export async function login(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email y contraseña son obligatorios" });
  }

  try {
    const user = await User.findOne({ email: email.toLowerCase().trim() });

    if (!user) {
      return res.status(401).json({ error: "Credenciales incorrectas" });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: "Credenciales incorrectas" });
    }

    setSessionCookie(
      res,
      {
        userId: user._id.toString(),
        email: user.email,
      }
    )

    res.status(201).json({
      user: {
        _id: user._id,
        name: user.name,
        email: user.email
      }
    });
  } catch (err) {
    console.error("Error al iniciar sesión:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
}
export async function logout(_req, res) {
  res.cookie("token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0, // 0 milisegundos
    path: "/"
  })

  res.json({ success: true });
}


export async function me(req, res) {
  if (!req.user) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const user = await User.findById(req.user.userId).select("-password")
  if (!user) {
    return res.status(404).json({ error: "Usuario no encontrado" })
  }

  res.json({ user })
}