import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import multer from "multer";
import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";

const db = new Database("narrative.db");

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    transcript JSON,
    summary TEXT,
    apod_results JSON,
    speaker_labels JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
  );
`);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = "uploads";
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
  },
});

const upload = multer({ 
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '1gb' }));
  app.use(express.urlencoded({ limit: '1gb', extended: true }));

  const parseRecording = (rec: any) => {
    if (!rec) return rec;
    return {
      ...rec,
      transcript: rec.transcript ? JSON.parse(rec.transcript) : null,
      apod_results: rec.apod_results ? JSON.parse(rec.apod_results) : null,
      speaker_labels: rec.speaker_labels ? JSON.parse(rec.speaker_labels) : null,
    };
  };

  // API Routes
  app.get("/api/cases", (req, res) => {
    const cases = db.prepare("SELECT * FROM cases ORDER BY created_at DESC").all();
    res.json(cases);
  });

  app.post("/api/cases", (req, res) => {
    const { name, description } = req.body;
    const id = uuidv4();
    db.prepare("INSERT INTO cases (id, name, description) VALUES (?, ?, ?)").run(id, name, description);
    res.json({ id, name, description });
  });

  app.get("/api/cases/:id", (req, res) => {
    const caseData = db.prepare("SELECT * FROM cases WHERE id = ?").get(req.params.id);
    if (!caseData) return res.status(404).json({ error: "Case not found" });
    
    const recordings = db.prepare("SELECT * FROM recordings WHERE case_id = ? ORDER BY created_at DESC").all(req.params.id);
    res.json({ ...caseData, recordings: recordings.map(parseRecording) });
  });

  app.post("/api/cases/:id/recordings", upload.single("file"), (req: any, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    
    const id = uuidv4();
    const { id: caseId } = req.params;
    const { filename, originalname, mimetype, size } = req.file;

    db.prepare(`
      INSERT INTO recordings (id, case_id, filename, original_name, mime_type, size)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, caseId, filename, originalname, mimetype, size);

    res.json({ id, filename, originalname, mimetype, size });
  });

  app.post("/api/upload", upload.single("file"), (req: any, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const { filename, originalname, mimetype, size } = req.file;
    res.json({ filename, originalname, mimetype, size });
  });

  app.get("/api/recordings/:id", (req, res) => {
    const recording = db.prepare("SELECT * FROM recordings WHERE id = ?").get(req.params.id);
    if (!recording) return res.status(404).json({ error: "Recording not found" });
    res.json(parseRecording(recording));
  });

  app.delete("/api/cases/:id", (req, res) => {
    const { id } = req.params;
    // Recordings are deleted automatically due to ON DELETE CASCADE
    const result = db.prepare("DELETE FROM cases WHERE id = ?").run(id);
    if (result.changes === 0) return res.status(404).json({ error: "Case not found" });
    res.json({ success: true });
  });

  app.patch("/api/recordings/:id", (req, res) => {
    const { transcript, summary, apod_results, speaker_labels } = req.body;
    const updates: string[] = [];
    const params: any[] = [];

    if (transcript !== undefined) {
      updates.push("transcript = ?");
      params.push(JSON.stringify(transcript));
    }
    if (summary !== undefined) {
      updates.push("summary = ?");
      params.push(summary);
    }
    if (apod_results !== undefined) {
      updates.push("apod_results = ?");
      params.push(JSON.stringify(apod_results));
    }
    if (speaker_labels !== undefined) {
      updates.push("speaker_labels = ?");
      params.push(JSON.stringify(speaker_labels));
    }

    if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });

    params.push(req.params.id);
    db.prepare(`UPDATE recordings SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    res.json({ success: true });
  });

  app.use("/uploads", express.static("uploads"));

  // Error handler for Multer
  app.use((err: any, req: any, res: any, next: any) => {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File too large. Maximum size is 1GB." });
    }
    next(err);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
