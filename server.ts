import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import multer from "multer";
import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";

// In your Electron app, you would set this path
// if (process.env.FFMPEG_PATH) {
//   ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
// }

const db = new Database("narrative.db");

// Ensure uploads directory exists
const uploadDir = "uploads";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Helper to extract audio from video
const conversionJobs = new Map<string, number>();

const extractAudio = (inputPath: string, outputPath: string, jobId?: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (jobId) conversionJobs.set(jobId, 0);
    let command = ffmpeg(inputPath)
      .toFormat('mp3')
      .on('progress', (progress) => {
        if (jobId && progress.percent) {
          conversionJobs.set(jobId, Math.round(progress.percent));
        }
      })
      .on('end', () => {
        if (jobId) conversionJobs.set(jobId, 100);
        resolve();
      })
      .on('error', (err) => {
        if (jobId) conversionJobs.delete(jobId);
        reject(err);
      });
    
    command.save(outputPath);
  });
};

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
    transcription_filename TEXT,
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

  app.get("/api/stats", (req, res) => {
    try {
      const totalCases = db.prepare("SELECT COUNT(*) as count FROM cases").get() as any;
      const totalRecordings = db.prepare("SELECT COUNT(*) as count FROM recordings").get() as any;
      const totalSize = db.prepare("SELECT SUM(size) as total FROM recordings").get() as any;
      const mimeTypes = db.prepare("SELECT mime_type, COUNT(*) as count FROM recordings GROUP BY mime_type").all() as any[];
      
      const recentActivity = db.prepare(`
        SELECT date(created_at) as date, COUNT(*) as count 
        FROM recordings 
        WHERE created_at > date('now', '-7 days')
        GROUP BY date(created_at) 
        ORDER BY date ASC
      `).all() as any[];

      res.json({
        totalCases: totalCases.count,
        totalRecordings: totalRecordings.count,
        totalSize: totalSize.total || 0,
        mimeTypes,
        recentActivity
      });
    } catch (error) {
      console.error("Stats fetch failed:", error);
      res.status(500).json({ error: "Failed to fetch statistics" });
    }
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

  app.post("/api/cases/:id/recordings", upload.single("file"), async (req: any, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    
    const id = uuidv4();
    const { id: caseId } = req.params;
    const { filename, originalname, mimetype, size, path: filePath } = req.file;

    let transcriptionFilename = filename;
    const isVideo = mimetype.startsWith('video/');
    const isWav = mimetype === 'audio/wav' || mimetype === 'audio/x-wav' || originalname.toLowerCase().endsWith('.wav');

    if (isVideo || isWav) {
      const audioFilename = `${uuidv4()}.mp3`;
      const audioPath = path.join("uploads", audioFilename);
      
      // Start conversion in background
      extractAudio(filePath, audioPath, id)
        .then(() => {
          db.prepare("UPDATE recordings SET transcription_filename = ? WHERE id = ?").run(audioFilename, id);
        })
        .catch(err => console.error("Background conversion failed:", err));
      
      // Return immediately so client can poll
      db.prepare(`
        INSERT INTO recordings (id, case_id, filename, transcription_filename, original_name, mime_type, size)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, caseId, filename, filename, originalname, mimetype, size);

      return res.json({ id, filename, transcriptionFilename: filename, originalname, mimetype, size, status: 'converting' });
    }

    db.prepare(`
      INSERT INTO recordings (id, case_id, filename, transcription_filename, original_name, mime_type, size)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, caseId, filename, transcriptionFilename, originalname, mimetype, size);

    res.json({ id, filename, transcriptionFilename, originalname, mimetype, size, status: 'ready' });
  });

  app.post("/api/recordings/:id/convert", async (req, res) => {
    const { id } = req.params;
    const recording = db.prepare("SELECT * FROM recordings WHERE id = ?").get(id);
    if (!recording) return res.status(404).json({ error: "Recording not found" });

    const inputPath = path.join("uploads", recording.filename);
    const audioFilename = `${uuidv4()}.mp3`;
    const audioPath = path.join("uploads", audioFilename);

    // Start conversion in background
    extractAudio(inputPath, audioPath, id)
      .then(() => {
        db.prepare("UPDATE recordings SET transcription_filename = ? WHERE id = ?").run(audioFilename, id);
      })
      .catch(err => console.error("On-demand conversion failed:", err));

    res.json({ success: true, jobId: id });
  });

  app.get("/api/recordings/:id/convert/progress", (req, res) => {
    const { id } = req.params;
    const progress = conversionJobs.get(id);
    if (progress === undefined) {
      // Check if it's already done
      const recording = db.prepare("SELECT * FROM recordings WHERE id = ?").get(id);
      if (recording && recording.transcription_filename !== recording.filename) {
        return res.json({ progress: 100, status: 'completed' });
      }
      return res.status(404).json({ error: "Job not found" });
    }
    res.json({ progress, status: progress === 100 ? 'completed' : 'processing' });
  });

  app.post("/api/upload", upload.single("file"), async (req: any, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const { filename, originalname, mimetype, size, path: filePath } = req.file;
    
    let transcriptionFilename = filename;
    const isVideo = mimetype.startsWith('video/');
    const isWav = mimetype === 'audio/wav' || mimetype === 'audio/x-wav' || originalname.toLowerCase().endsWith('.wav');

    if (isVideo || isWav) {
      const audioFilename = `${uuidv4()}.mp3`;
      const audioPath = path.join("uploads", audioFilename);
      const jobId = uuidv4();
      
      // Start conversion in background
      extractAudio(filePath, audioPath, jobId)
        .catch(err => console.error("Background upload conversion failed:", err));
      
      return res.json({ filename, transcriptionFilename: audioFilename, originalname, mimetype, size, status: 'converting', jobId });
    }
    
    res.json({ filename, transcriptionFilename, originalname, mimetype, size, status: 'ready' });
  });

  app.get("/api/jobs/:id/progress", (req, res) => {
    const { id } = req.params;
    const progress = conversionJobs.get(id);
    if (progress === undefined) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json({ progress, status: progress === 100 ? 'completed' : 'processing' });
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

  // Error handler for Multer and general errors
  app.use((err: any, req: any, res: any, next: any) => {
    console.error("Server Error:", err);
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File too large. Maximum size is 1GB." });
    }
    res.status(err.status || 500).json({ 
      error: err.message || "Internal Server Error",
      details: process.env.NODE_ENV !== 'production' ? err.stack : undefined
    });
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
