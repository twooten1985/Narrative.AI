import React, { useState, useEffect, useRef } from 'react';
import { 
  FolderOpen, 
  Plus, 
  FileAudio, 
  FileVideo, 
  Settings, 
  ChevronRight, 
  Play, 
  Pause, 
  SkipBack, 
  SkipForward,
  Clock,
  User,
  FileText,
  BarChart3,
  Save,
  Upload,
  Loader2,
  Trash2,
  HelpCircle,
  ExternalLink,
  Download
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format } from 'date-fns';
import { useDropzone } from 'react-dropzone';
import ReactMarkdown from 'react-markdown';
import { saveAs } from 'file-saver';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { Case, Recording, TranscriptData, Utterance, Word, ApodResult } from './types';
import { generateSummary, runApodAnalysis, INTERVIEW_PROMPTS } from './services/geminiService';
import { MassProcessingView } from './components/MassProcessingView';

export default function App() {
  const [cases, setCases] = useState<Case[]>([]);
  const [selectedCase, setSelectedCase] = useState<Case | null>(null);
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(null);
  const [activeTab, setActiveTab] = useState<'transcript' | 'summary' | 'apod'>('transcript');
  const [isCreatingCase, setIsCreatingCase] = useState(false);
  const [newCaseName, setNewCaseName] = useState('');
  const [newCaseDesc, setNewCaseDesc] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [processingStatus, setProcessingStatus] = useState('');
  const [assemblyKey, setAssemblyKey] = useState(localStorage.getItem('assembly_ai_key') || '');
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speakerLabels, setSpeakerLabels] = useState<Record<string, string>>({});
  const [interviewType, setInterviewType] = useState<string>("Suspect Interview");

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDeletingCase, setIsDeletingCase] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [tempAssemblyKey, setTempAssemblyKey] = useState(assemblyKey);
  const [topHeight, setTopHeight] = useState(400);
  const [isResizing, setIsResizing] = useState(false);
  const [mode, setMode] = useState<'cases' | 'mass-jail-call' | 'mass-keyword-search'>('cases');

  const mediaRef = useRef<HTMLMediaElement>(null);

  useEffect(() => {
    fetchCases();
  }, []);

  useEffect(() => {
    setTempAssemblyKey(assemblyKey);
  }, [assemblyKey]);

  useEffect(() => {
    if (selectedRecording?.speaker_labels) {
      setSpeakerLabels(selectedRecording.speaker_labels);
    } else {
      setSpeakerLabels({});
    }
  }, [selectedRecording]);

  const handleSaveSettings = () => {
    setAssemblyKey(tempAssemblyKey);
    localStorage.setItem('assembly_ai_key', tempAssemblyKey);
    setIsSettingsOpen(false);
  };

  const formatTime = (seconds: number) => {
    if (isNaN(seconds) || !isFinite(seconds)) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const parseSqliteDate = (dateStr: string) => {
    try {
      // SQLite CURRENT_TIMESTAMP is YYYY-MM-DD HH:MM:SS
      // JS Date prefers YYYY-MM-DDTHH:MM:SSZ
      const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
      const date = new Date(normalized);
      return isNaN(date.getTime()) ? new Date() : date;
    } catch (e) {
      return new Date();
    }
  };

  const safeFetch = async (url: string, options?: RequestInit) => {
    const res = await fetch(url, options);
    const contentType = res.headers.get("content-type");
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Server error (${res.status}): ${text.slice(0, 100)}`);
    }
    if (contentType && contentType.includes("application/json")) {
      return res.json();
    }
    return res.text();
  };

  const fetchCases = async () => {
    try {
      const data = await safeFetch('/api/cases');
      setCases(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error("Failed to fetch cases:", error);
      setCases([]);
    }
  };

  const fetchCaseDetails = async (id: string) => {
    try {
      setMode('cases');
      const data = await safeFetch(`/api/cases/${id}`);
      setSelectedCase(data);
    } catch (error) {
      console.error("Failed to fetch case details:", error);
    }
  };

  const handleCreateCase = async () => {
    if (!newCaseName) return;
    try {
      const data = await safeFetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newCaseName, description: newCaseDesc }),
      });
      setCases([data, ...cases]);
      setIsCreatingCase(false);
      setNewCaseName('');
      setNewCaseDesc('');
    } catch (error) {
      console.error("Failed to create case:", error);
    }
  };

  const handleDeleteCase = async () => {
    if (!selectedCase) return;
    try {
      await safeFetch(`/api/cases/${selectedCase.id}`, {
        method: 'DELETE',
      });
      setCases(cases.filter(c => c.id !== selectedCase.id));
      setSelectedCase(null);
      setSelectedRecording(null);
      setIsDeletingCase(false);
    } catch (error) {
      console.error("Failed to delete case:", error);
      alert("Failed to delete case.");
    }
  };

  const onDrop = async (acceptedFiles: File[]) => {
    if (!selectedCase) return;
    setIsUploading(true);
    const formData = new FormData();
    formData.append('file', acceptedFiles[0]);

    try {
      await safeFetch(`/api/cases/${selectedCase.id}/recordings`, {
        method: 'POST',
        body: formData,
      });
      await fetchCaseDetails(selectedCase.id);
    } catch (error) {
      console.error("Upload failed:", error);
      alert("Upload failed. Check server logs.");
    } finally {
      setIsUploading(false);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ 
    onDrop,
    accept: {
      'audio/*': ['.mp3', '.wav', '.m4a'],
      'video/*': ['.mp4', '.mov', '.mpg']
    },
    multiple: false
  });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const newHeight = Math.max(200, Math.min(window.innerHeight - 200, e.clientY - 100));
      setTopHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.cursor = 'default';
    };

    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'row-resize';
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  const handleTranscribe = async () => {
    if (!selectedRecording || !assemblyKey) {
      alert("Please provide an AssemblyAI API Key in settings.");
      return;
    }
    setIsProcessing(true);
    setProcessingProgress(15);
    setProcessingStatus('Uploading to AssemblyAI...');
    try {
      // Helper to handle AssemblyAI responses safely
      const handleAssemblyRes = async (res: Response) => {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          return res.json();
        }
        const text = await res.text();
        if (text.toLowerCase().includes("api key is disabled")) {
          throw new Error("AssemblyAI Error: Your API key is disabled. Please check your account at assemblyai.com.");
        }
        throw new Error(text || `AssemblyAI error: ${res.status}`);
      };

      // 1. Get the file from our server as a blob
      const fileRes = await fetch(`/uploads/${selectedRecording.filename}`);
      const blob = await fileRes.blob();

      // 2. Upload to AssemblyAI
      const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: { 'authorization': assemblyKey },
        body: blob
      });
      
      const uploadData = await handleAssemblyRes(uploadRes);
      if (!uploadRes.ok) throw new Error(uploadData.error || "Upload to AssemblyAI failed");

      setProcessingProgress(30);
      setProcessingStatus('Starting Transcription...');

      // 3. Start transcription
      const transcriptRes = await fetch('https://api.assemblyai.com/v2/transcript', {
        method: 'POST',
        headers: {
          'authorization': assemblyKey,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          audio_url: uploadData.upload_url,
          speaker_labels: true
        })
      });

      let transcriptData = await handleAssemblyRes(transcriptRes);
      if (!transcriptRes.ok) throw new Error(transcriptData.error || "Transcription start failed");
      
      setProcessingProgress(45);
      setProcessingStatus('Transcribing...');

      // 4. Poll for completion
      while (transcriptData.status !== 'completed' && transcriptData.status !== 'error') {
        await new Promise(r => setTimeout(r, 3000));
        const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptData.id}`, {
          headers: { 'authorization': assemblyKey }
        });
        transcriptData = await handleAssemblyRes(pollRes);
        
        // Increment progress slightly while polling
        setProcessingProgress(prev => Math.min(85, prev + 5));
      }

      if (transcriptData.status === 'completed') {
        setProcessingProgress(90);
        setProcessingStatus('Finalizing Analysis...');
        // 5. Save to our DB
        await safeFetch(`/api/recordings/${selectedRecording.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript: transcriptData }),
        });
        
        // 6. Generate Summary and APOD
        const summary = await generateSummary(transcriptData.text, interviewType);
        let apod = null;
        if (interviewType === "Child Harm Suspect Interview") {
          apod = await runApodAnalysis(transcriptData.text);
        }

        await safeFetch(`/api/recordings/${selectedRecording.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary, apod_results: apod }),
        });
        
        setProcessingProgress(100);
        setProcessingStatus('Complete');
        await fetchCaseDetails(selectedCase!.id);
        const updatedRec = await safeFetch(`/api/recordings/${selectedRecording.id}`);
        setSelectedRecording(updatedRec);
      } else {
        const errorMsg = transcriptData.error || "";
        if (errorMsg.toLowerCase().includes("insufficient funds") || errorMsg.toLowerCase().includes("balance")) {
          alert("AssemblyAI Error: Insufficient funds. Please check your account balance at assemblyai.com.");
        } else if (errorMsg.toLowerCase().includes("api key is disabled")) {
          alert("AssemblyAI Error: Your API key is disabled. Please check your account at assemblyai.com.");
        } else {
          alert("Transcription failed: " + errorMsg);
        }
      }
    } catch (error: any) {
      console.error(error);
      const msg = error.message || "";
      if (msg.toLowerCase().includes("insufficient funds") || msg.toLowerCase().includes("balance")) {
        alert("AssemblyAI Error: Insufficient funds. Please check your account balance at assemblyai.com.");
      } else if (msg.toLowerCase().includes("api key is disabled")) {
        alert("AssemblyAI Error: Your API key is disabled. Please check your account at assemblyai.com.");
      } else {
        alert("Error during transcription: " + msg);
      }
    } finally {
      setIsProcessing(false);
      setProcessingProgress(0);
      setProcessingStatus('');
    }
  };

  const handleTimeUpdate = () => {
    if (mediaRef.current) {
      setCurrentTime(mediaRef.current.currentTime);
    }
  };

  const parseMarkdownToDocx = (markdown: string) => {
    const lines = markdown.split('\n');
    const paragraphs: Paragraph[] = [];

    const parseInlineMarkdown = (text: string) => {
      const parts: TextRun[] = [];
      const boldRegex = /\*\*(.*?)\*\*/g;
      let lastIndex = 0;
      let match;

      while ((match = boldRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          parts.push(new TextRun({ text: text.substring(lastIndex, match.index) }));
        }
        parts.push(new TextRun({ text: match[1], bold: true }));
        lastIndex = boldRegex.lastIndex;
      }

      if (lastIndex < text.length) {
        parts.push(new TextRun({ text: text.substring(lastIndex) }));
      }

      return parts.length > 0 ? parts : [new TextRun({ text })];
    };

    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) {
        paragraphs.push(new Paragraph({ text: "" }));
        return;
      }

      if (trimmed.startsWith('### ')) {
        paragraphs.push(new Paragraph({
          text: trimmed.replace('### ', ''),
          heading: HeadingLevel.HEADING_3,
        }));
      } else if (trimmed.startsWith('## ')) {
        paragraphs.push(new Paragraph({
          text: trimmed.replace('## ', ''),
          heading: HeadingLevel.HEADING_2,
        }));
      } else if (trimmed.startsWith('# ')) {
        paragraphs.push(new Paragraph({
          text: trimmed.replace('# ', ''),
          heading: HeadingLevel.HEADING_1,
        }));
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        const content = trimmed.substring(2);
        paragraphs.push(new Paragraph({
          children: parseInlineMarkdown(content),
          bullet: { level: 0 },
        }));
      } else {
        paragraphs.push(new Paragraph({
          children: parseInlineMarkdown(trimmed),
        }));
      }
    });

    return paragraphs;
  };

  const handleExportDocx = async () => {
    if (!selectedRecording || !selectedRecording.transcript || !selectedCase) return;

    const doc = new Document({
      sections: [{
        properties: {},
        children: [
          new Paragraph({
            text: `Case: ${selectedCase.name}`,
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.CENTER,
          }),
          new Paragraph({
            text: `Recording: ${selectedRecording.original_name}`,
            heading: HeadingLevel.HEADING_2,
            alignment: AlignmentType.CENTER,
          }),
          new Paragraph({
            text: `Date: ${format(parseSqliteDate(selectedRecording.created_at), 'MMMM d, yyyy')}`,
            alignment: AlignmentType.CENTER,
          }),
          new Paragraph({ text: "" }), // Spacer
          
          new Paragraph({
            text: "Summary",
            heading: HeadingLevel.HEADING_2,
          }),
          ...parseMarkdownToDocx(selectedRecording.summary || "No summary available."),
          new Paragraph({ text: "" }), // Spacer
          new Paragraph({
            text: "Transcript",
            heading: HeadingLevel.HEADING_2,
          }),
          ...(selectedRecording.transcript.utterances || []).flatMap(u => [
            new Paragraph({
              children: [
                new TextRun({
                  text: `${speakerLabels[u.speaker] || `Speaker ${u.speaker}`} (${formatTime(u.start / 1000)}):`,
                  bold: true,
                }),
              ],
            }),
            new Paragraph({
              children: [
                new TextRun({
                  text: u.text,
                }),
              ],
            }),
            new Paragraph({ text: "" }), // Spacer
          ]),
        ],
      }],
    });

    const blob = await Packer.toBlob(doc);
    saveAs(blob, `${selectedCase.name}_${selectedRecording.original_name}.docx`);
  };

  const seekTo = (time: number) => {
    if (mediaRef.current) {
      mediaRef.current.currentTime = time;
      mediaRef.current.play();
      setIsPlaying(true);
    }
  };

  const saveSpeakerLabels = async () => {
    if (!selectedRecording) return;
    try {
      await safeFetch(`/api/recordings/${selectedRecording.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speaker_labels: speakerLabels }),
      });
    } catch (error) {
      console.error("Failed to save speaker labels:", error);
    }
  };

  const isWordActive = (word: Word) => {
    const timeMs = currentTime * 1000;
    return timeMs >= word.start && timeMs <= word.end;
  };

  return (
    <div className="flex h-screen bg-[#0F1115] text-white font-sans overflow-hidden">
      {/* Sidebar */}
      <div className="w-72 border-r border-white/10 flex flex-col bg-[#16191E]">
        <div className="p-6 border-b border-white/10 flex items-center gap-3">
          <div className="w-8 h-8 bg-orange-500 rounded-lg flex items-center justify-center">
            <BarChart3 size={18} className="text-white" />
          </div>
          <h1 className="text-lg font-bold tracking-tight">Narrative.AI</h1>
        </div>

        <div className="p-4 flex-1 overflow-y-auto space-y-2">
          <div className="flex items-center justify-between mb-4 px-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-white/40">Cases</span>
            <button 
              onClick={() => setIsCreatingCase(true)}
              className="p-1 hover:bg-white/5 rounded-md transition-colors text-orange-500"
            >
              <Plus size={18} />
            </button>
          </div>

          {isCreatingCase && (
            <div className="p-3 bg-white/5 rounded-xl border border-white/10 space-y-3 mb-4">
              <input 
                autoFocus
                placeholder="Case Name"
                className="w-full bg-transparent border-none focus:ring-0 text-sm p-0"
                value={newCaseName}
                onChange={e => setNewCaseName(e.target.value)}
              />
              <textarea 
                placeholder="Description"
                className="w-full bg-transparent border-none focus:ring-0 text-xs p-0 resize-none opacity-60"
                rows={2}
                value={newCaseDesc}
                onChange={e => setNewCaseDesc(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <button onClick={() => setIsCreatingCase(false)} className="text-[10px] uppercase font-bold opacity-50">Cancel</button>
                <button onClick={handleCreateCase} className="text-[10px] uppercase font-bold text-orange-500">Create</button>
              </div>
            </div>
          )}

          {cases?.map(c => (
            <button 
              key={c.id}
              onClick={() => fetchCaseDetails(c.id)}
              className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all group ${mode === 'cases' && selectedCase?.id === c.id ? 'bg-orange-500/10 text-orange-500' : 'hover:bg-white/5 text-white/60'}`}
            >
              <FolderOpen size={18} className={mode === 'cases' && selectedCase?.id === c.id ? 'text-orange-500' : 'text-white/40'} />
              <div className="text-left flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{c.name}</p>
                <p className="text-[10px] opacity-50">{format(parseSqliteDate(c.created_at), 'MMM d, yyyy')}</p>
              </div>
              <ChevronRight size={14} className={`opacity-0 group-hover:opacity-100 transition-opacity ${mode === 'cases' && selectedCase?.id === c.id ? 'opacity-100' : ''}`} />
            </button>
          ))}
        </div>

        <div className="p-4 border-t border-white/10 space-y-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-white/30 px-2">Mass Tools</span>
          <button 
            onClick={() => {
              setMode('mass-jail-call');
              setSelectedCase(null);
              setSelectedRecording(null);
            }}
            className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all ${mode === 'mass-jail-call' ? 'bg-orange-500/10 text-orange-500' : 'hover:bg-white/5 text-white/60'}`}
          >
            <BarChart3 size={18} className={mode === 'mass-jail-call' ? 'text-orange-500' : 'text-white/40'} />
            <span className="text-sm font-medium">Mass Jail Call</span>
          </button>
          <button 
            onClick={() => {
              setMode('mass-keyword-search');
              setSelectedCase(null);
              setSelectedRecording(null);
            }}
            className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all ${mode === 'mass-keyword-search' ? 'bg-orange-500/10 text-orange-500' : 'hover:bg-white/5 text-white/60'}`}
          >
            <FileText size={18} className={mode === 'mass-keyword-search' ? 'text-orange-500' : 'text-white/40'} />
            <span className="text-sm font-medium">Keyword Search</span>
          </button>
        </div>

        <div className="p-4 border-t border-white/10 space-y-2">
          <button 
            onClick={() => setIsHelpOpen(true)}
            className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 text-white/60 transition-all"
          >
            <HelpCircle size={18} className="text-white/40" />
            <span className="text-sm font-medium">How it Works</span>
          </button>
          <button 
            onClick={() => setIsSettingsOpen(true)}
            className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 text-white/60 transition-all"
          >
            <Settings size={18} className="text-white/40" />
            <span className="text-sm font-medium">Settings</span>
          </button>
        </div>
      </div>

      {/* Help Modal */}
      <AnimatePresence>
        {isHelpOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsHelpOpen(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-2xl bg-[#16191E] border border-white/10 rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="p-8 max-h-[80vh] overflow-y-auto">
                <div className="flex items-center gap-3 mb-8">
                  <div className="w-10 h-10 bg-orange-500/10 rounded-xl flex items-center justify-center">
                    <HelpCircle size={20} className="text-orange-500" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold">Getting Started</h3>
                    <p className="text-xs text-white/40">Follow these steps to begin your analysis</p>
                  </div>
                </div>

                <div className="space-y-8">
                  <section className="space-y-4">
                    <h4 className="text-sm font-bold uppercase tracking-widest text-orange-500">1. Setup AssemblyAI</h4>
                    <div className="bg-black/20 rounded-2xl p-4 border border-white/5 space-y-3">
                      <p className="text-sm text-white/70 leading-relaxed">
                        Narrative.AI uses AssemblyAI for high-accuracy transcription and speaker identification.
                      </p>
                      <ul className="space-y-2">
                        <li className="flex items-start gap-2 text-xs text-white/50">
                          <div className="w-1.5 h-1.5 rounded-full bg-orange-500 mt-1 flex-shrink-0" />
                          <span>Go to <a href="https://www.assemblyai.com" target="_blank" rel="noopener noreferrer" className="text-orange-500 hover:underline inline-flex items-center gap-1">assemblyai.com <ExternalLink size={10} /></a> and create a free account.</span>
                        </li>
                        <li className="flex items-start gap-2 text-xs text-white/50">
                          <div className="w-1.5 h-1.5 rounded-full bg-orange-500 mt-1 flex-shrink-0" />
                          <span>Copy your <span className="text-white">API Key</span> from the dashboard.</span>
                        </li>
                        <li className="flex items-start gap-2 text-xs text-white/50">
                          <div className="w-1.5 h-1.5 rounded-full bg-orange-500 mt-1 flex-shrink-0" />
                          <span>Click <span className="text-white">Settings</span> in the sidebar here and paste your key.</span>
                        </li>
                      </ul>
                    </div>
                  </section>

                  <section className="space-y-4">
                    <h4 className="text-sm font-bold uppercase tracking-widest text-orange-500">2. Workflow</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="bg-white/5 rounded-2xl p-4 border border-white/5">
                        <div className="w-8 h-8 bg-white/5 rounded-lg flex items-center justify-center mb-3">
                          <Plus size={16} className="text-white/60" />
                        </div>
                        <h5 className="text-xs font-bold mb-1">Create a Case</h5>
                        <p className="text-[10px] text-white/40 leading-relaxed">Organize your recordings by case name and description.</p>
                      </div>
                      <div className="bg-white/5 rounded-2xl p-4 border border-white/5">
                        <div className="w-8 h-8 bg-white/5 rounded-lg flex items-center justify-center mb-3">
                          <Upload size={16} className="text-white/60" />
                        </div>
                        <h5 className="text-xs font-bold mb-1">Upload Media</h5>
                        <p className="text-[10px] text-white/40 leading-relaxed">Upload audio or video files directly into your case.</p>
                      </div>
                      <div className="bg-white/5 rounded-2xl p-4 border border-white/5">
                        <div className="w-8 h-8 bg-white/5 rounded-lg flex items-center justify-center mb-3">
                          <FileText size={16} className="text-white/60" />
                        </div>
                        <h5 className="text-xs font-bold mb-1">Transcribe</h5>
                        <p className="text-[10px] text-white/40 leading-relaxed">Convert speech to text with automatic speaker detection.</p>
                      </div>
                      <div className="bg-white/5 rounded-2xl p-4 border border-white/5">
                        <div className="w-8 h-8 bg-white/5 rounded-lg flex items-center justify-center mb-3">
                          <BarChart3 size={16} className="text-white/60" />
                        </div>
                        <h5 className="text-xs font-bold mb-1">Analyze</h5>
                        <p className="text-[10px] text-white/40 leading-relaxed">Get AI-generated summaries and forensic APOD analysis.</p>
                      </div>
                    </div>
                  </section>
                </div>

                <button 
                  onClick={() => setIsHelpOpen(false)}
                  className="w-full mt-10 px-4 py-3 rounded-xl font-bold text-sm bg-orange-500 hover:bg-orange-600 transition-all shadow-lg shadow-orange-500/20"
                >
                  Got it, thanks!
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {isSettingsOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsSettingsOpen(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-md bg-[#16191E] border border-white/10 rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="p-8">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 bg-orange-500/10 rounded-xl flex items-center justify-center">
                    <Settings size={20} className="text-orange-500" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold">Settings</h3>
                    <p className="text-xs text-white/40">Configure your application keys</p>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-white/40 px-1">AssemblyAI API Key</label>
                    <div className="relative">
                      <input 
                        type="password"
                        value={tempAssemblyKey}
                        onChange={e => setTempAssemblyKey(e.target.value)}
                        placeholder="Enter your API key"
                        className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-sm focus:border-orange-500 transition-colors outline-none"
                      />
                    </div>
                    <p className="text-[10px] text-white/30 px-1">
                      Required for transcription and speaker labeling. Get one at <a href="https://www.assemblyai.com" target="_blank" rel="noopener noreferrer" className="text-orange-500 hover:underline">assemblyai.com</a>
                    </p>
                  </div>
                </div>

                <div className="flex gap-3 mt-10">
                  <button 
                    onClick={() => setIsSettingsOpen(false)}
                    className="flex-1 px-4 py-3 rounded-xl font-bold text-sm bg-white/5 hover:bg-white/10 transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleSaveSettings}
                    className="flex-1 px-4 py-3 rounded-xl font-bold text-sm bg-orange-500 hover:bg-orange-600 transition-all shadow-lg shadow-orange-500/20"
                  >
                    Save Changes
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {isDeletingCase && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsDeletingCase(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-md bg-[#16191E] border border-white/10 rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="p-8">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 bg-red-500/10 rounded-xl flex items-center justify-center">
                    <Trash2 size={20} className="text-red-500" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold">Delete Case</h3>
                    <p className="text-xs text-white/40">This action cannot be undone</p>
                  </div>
                </div>

                <p className="text-sm text-white/60 mb-8">
                  Are you sure you want to delete <span className="text-white font-bold">"{selectedCase?.name}"</span>? This will permanently remove all associated recordings and transcripts.
                </p>

                <div className="flex gap-3">
                  <button 
                    onClick={() => setIsDeletingCase(false)}
                    className="flex-1 px-4 py-3 rounded-xl font-bold text-sm bg-white/5 hover:bg-white/10 transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleDeleteCase}
                    className="flex-1 px-4 py-3 rounded-xl font-bold text-sm bg-red-500 hover:bg-red-600 transition-all shadow-lg shadow-red-500/20"
                  >
                    Delete Case
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {mode !== 'cases' ? (
          <MassProcessingView mode={mode as any} assemblyKey={assemblyKey} />
        ) : !selectedCase ? (
          <div className="flex-1 flex flex-col items-center justify-center opacity-20">
            <FolderOpen size={64} strokeWidth={1} />
            <p className="mt-4 text-lg font-light">Select or create a case to begin</p>
          </div>
        ) : (
          <>
            {/* Case Header */}
            <div className="p-6 border-b border-white/10 flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold tracking-tight">{selectedCase.name}</h2>
                <p className="text-sm text-white/40">{selectedCase.description}</p>
              </div>
              <div className="flex items-center gap-4">
                <button 
                  onClick={() => setIsDeletingCase(true)}
                  className="p-2 bg-red-500/10 text-red-500 hover:bg-red-500/20 rounded-lg transition-all"
                  title="Delete Case"
                >
                  <Trash2 size={18} />
                </button>
                <select 
                  className="bg-[#16191E] border border-white/10 rounded-lg text-xs px-3 py-2 outline-none focus:border-orange-500 transition-colors"
                  value={interviewType}
                  onChange={e => setInterviewType(e.target.value)}
                >
                  {Object.keys(INTERVIEW_PROMPTS).map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <div {...getRootProps()} className={`px-4 py-2 rounded-lg border border-dashed border-white/20 hover:border-orange-500/50 hover:bg-orange-500/5 transition-all cursor-pointer flex items-center gap-2 text-sm ${isUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                  <input {...getInputProps()} />
                  {isUploading ? <Loader2 className="animate-spin" size={16} /> : <Upload size={16} />}
                  <span>{isUploading ? 'Uploading...' : 'Add Recording'}</span>
                </div>
              </div>
            </div>

            <div className="flex-1 flex overflow-hidden">
              {/* Recordings List */}
              <div className="w-64 border-r border-white/10 overflow-y-auto p-4 space-y-3">
                <span className="text-[10px] font-bold uppercase tracking-widest text-white/30 px-2">Recordings</span>
                {selectedCase.recordings?.map(r => (
                  <button 
                    key={r.id}
                    onClick={() => setSelectedRecording(r)}
                    className={`w-full text-left p-3 rounded-xl transition-all border ${selectedRecording?.id === r.id ? 'bg-white/5 border-white/20' : 'border-transparent hover:bg-white/5'}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {r.mime_type.startsWith('video') ? <FileVideo size={14} className="text-blue-400" /> : <FileAudio size={14} className="text-orange-400" />}
                      <span className="text-xs font-medium truncate">{r.original_name}</span>
                    </div>
                    <div className="flex items-center justify-between opacity-40">
                      <span className="text-[10px]">{format(parseSqliteDate(r.created_at), 'MMM d')}</span>
                      <span className="text-[10px]">{(r.size / 1024 / 1024).toFixed(1)} MB</span>
                    </div>
                  </button>
                ))}
              </div>

              {/* Viewer Area */}
              <div className="flex-1 flex flex-col min-w-0 bg-[#0F1115]">
                {selectedRecording ? (
                  <>
                    {/* Media Player */}
                    <div 
                      className="bg-black/20 border-b border-white/10 overflow-hidden flex flex-col"
                      style={{ height: `${topHeight}px` }}
                    >
                      <div className="flex-1 p-6 flex items-center justify-center">
                        <div className="w-full max-w-3xl h-full">
                          <div className="w-full h-full bg-black rounded-2xl overflow-hidden relative group border border-white/5 shadow-2xl">
                            {selectedRecording.mime_type.startsWith('video') ? (
                              <video 
                                ref={mediaRef as any}
                                src={`/uploads/${selectedRecording.filename}`}
                                className="w-full h-full object-contain"
                                onTimeUpdate={handleTimeUpdate}
                                onPlay={() => setIsPlaying(true)}
                                onPause={() => setIsPlaying(false)}
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-orange-500/10 to-blue-500/10">
                                <FileAudio size={64} className="text-orange-500/40 animate-pulse" />
                                <audio 
                                  ref={mediaRef as any}
                                  src={`/uploads/${selectedRecording.filename}`}
                                  onTimeUpdate={handleTimeUpdate}
                                  onPlay={() => setIsPlaying(true)}
                                  onPause={() => setIsPlaying(false)}
                                />
                              </div>
                            )}
                            
                            {/* Custom Controls Overlay */}
                            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-6">
                              <div className="flex items-center gap-4">
                                <button onClick={() => isPlaying ? mediaRef.current?.pause() : mediaRef.current?.play()} className="w-10 h-10 bg-white text-black rounded-full flex items-center justify-center hover:scale-110 transition-transform">
                                  {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} className="ml-1" fill="currentColor" />}
                                </button>
                                <div className="flex-1">
                                  <div className="h-1 bg-white/20 rounded-full overflow-hidden cursor-pointer" onClick={(e) => {
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const x = e.clientX - rect.left;
                                    const pct = x / rect.width;
                                    if (mediaRef.current) mediaRef.current.currentTime = pct * mediaRef.current.duration;
                                  }}>
                                    <div 
                                      className="h-full bg-orange-500" 
                                      style={{ width: `${(currentTime / (mediaRef.current?.duration || 1)) * 100}%` }}
                                    />
                                  </div>
                                  <div className="flex justify-between mt-2 text-[10px] font-mono opacity-60">
                                    <span>{formatTime(currentTime)}</span>
                                    <span>{formatTime(mediaRef.current?.duration || 0)}</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Resize Handle */}
                    <div 
                      className="h-1.5 w-full bg-transparent hover:bg-orange-500/30 cursor-row-resize transition-colors relative z-10 flex items-center justify-center group"
                      onMouseDown={() => setIsResizing(true)}
                    >
                      <div className="w-8 h-1 rounded-full bg-white/10 group-hover:bg-orange-500/50 transition-colors" />
                    </div>

                    {/* Tabs */}
                    <div className="flex border-b border-white/10 px-6 items-center justify-between">
                      <div className="flex">
                        <button 
                          onClick={() => setActiveTab('transcript')}
                          className={`px-4 py-4 text-xs font-bold uppercase tracking-widest transition-all border-b-2 ${activeTab === 'transcript' ? 'border-orange-500 text-orange-500' : 'border-transparent text-white/40'}`}
                        >
                          Transcript
                        </button>
                        <button 
                          onClick={() => setActiveTab('summary')}
                          className={`px-4 py-4 text-xs font-bold uppercase tracking-widest transition-all border-b-2 ${activeTab === 'summary' ? 'border-orange-500 text-orange-500' : 'border-transparent text-white/40'}`}
                        >
                          Summary
                        </button>
                        {selectedRecording.apod_results && (
                          <button 
                            onClick={() => setActiveTab('apod')}
                            className={`px-4 py-4 text-xs font-bold uppercase tracking-widest transition-all border-b-2 ${activeTab === 'apod' ? 'border-orange-500 text-orange-500' : 'border-transparent text-white/40'}`}
                          >
                            APOD Analysis
                          </button>
                        )}
                      </div>
                      {selectedRecording.summary && selectedRecording.transcript && (
                        <button 
                          onClick={handleExportDocx}
                          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-orange-500/10 text-orange-500 hover:bg-orange-500/20 transition-all text-[10px] font-bold uppercase tracking-wider"
                        >
                          <Download size={14} />
                          Export DOCX
                        </button>
                      )}
                    </div>

                    {/* Tab Content */}
                    <div className="flex-1 overflow-y-auto p-6">
                      <AnimatePresence mode="wait">
                        {activeTab === 'transcript' && (
                          <motion.div 
                            key="transcript"
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -10 }}
                            className="max-w-3xl mx-auto space-y-8"
                          >
                            {!selectedRecording.transcript ? (
                              <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-white/5 rounded-3xl">
                                <FileText size={48} className="text-white/10 mb-4" />
                                <p className="text-white/40 mb-6">No transcript available for this recording</p>
                                
                                {isProcessing ? (
                                  <div className="w-full max-w-md px-8 space-y-4">
                                    <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-orange-500">
                                      <span>{processingStatus}</span>
                                      <span>{processingProgress}%</span>
                                    </div>
                                    <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                                      <motion.div 
                                        initial={{ width: 0 }}
                                        animate={{ width: `${processingProgress}%` }}
                                        className="h-full bg-orange-500 transition-all duration-500"
                                      />
                                    </div>
                                  </div>
                                ) : (
                                  <button 
                                    onClick={handleTranscribe}
                                    disabled={isProcessing}
                                    className="px-6 py-3 bg-orange-500 hover:bg-orange-600 rounded-xl font-bold text-sm transition-all flex items-center gap-2 disabled:opacity-50"
                                  >
                                    <FileText size={18} />
                                    Start Transcription
                                  </button>
                                )}
                              </div>
                            ) : (
                              <div className="space-y-6">
                                {selectedRecording.transcript.utterances?.map((u, i) => (
                                  <div key={i} className="group">
                                    <div className="flex items-center gap-3 mb-2">
                                      <div className="flex items-center gap-2">
                                        <User size={14} className="text-orange-500" />
                                        <input 
                                          className="bg-transparent border-none focus:ring-0 text-xs font-bold uppercase tracking-wider p-0 w-32 text-orange-500"
                                          value={speakerLabels[u.speaker] || `Speaker ${u.speaker}`}
                                          onChange={e => {
                                            setSpeakerLabels({ ...speakerLabels, [u.speaker]: e.target.value });
                                          }}
                                          onBlur={saveSpeakerLabels}
                                        />
                                      </div>
                                      <span className="text-[10px] font-mono opacity-30">{formatTime(u.start / 1000)}</span>
                                    </div>
                                    <div className="relative group/text">
                                      <p 
                                        contentEditable
                                        suppressContentEditableWarning
                                        onBlur={async (e) => {
                                          const newText = e.currentTarget.innerText;
                                          if (newText === u.text) return;
                                          
                                          const newUtterances = [...(selectedRecording.transcript?.utterances || [])];
                                          newUtterances[i] = { ...u, text: newText };
                                          
                                          await fetch(`/api/recordings/${selectedRecording.id}`, {
                                            method: 'PATCH',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ 
                                              transcript: { 
                                                ...selectedRecording.transcript, 
                                                utterances: newUtterances 
                                              } 
                                            }),
                                          });
                                          setSelectedRecording({
                                            ...selectedRecording,
                                            transcript: { ...selectedRecording.transcript!, utterances: newUtterances }
                                          });
                                        }}
                                        className="text-lg leading-relaxed text-white/80 font-light outline-none focus:bg-white/5 rounded p-1 transition-colors"
                                      >
                                        {u.words?.map((w, wi) => (
                                          <span 
                                            key={wi}
                                            onClick={(e) => {
                                              if (e.ctrlKey || e.metaKey) {
                                                seekTo(w.start / 1000);
                                              }
                                            }}
                                            className={`transition-all rounded px-0.5 ${isWordActive(w) ? 'bg-orange-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.5)]' : 'hover:bg-white/10'}`}
                                          >
                                            {w.text}{' '}
                                          </span>
                                        ))}
                                      </p>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </motion.div>
                        )}

                        {activeTab === 'summary' && (
                          <motion.div 
                            key="summary"
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -10 }}
                            className="max-w-3xl mx-auto"
                          >
                            {selectedRecording.summary ? (
                              <div className="prose prose-invert prose-orange max-w-none">
                                <ReactMarkdown>{selectedRecording.summary}</ReactMarkdown>
                              </div>
                            ) : (
                              <div className="text-center py-20 opacity-40">
                                <FileText size={48} className="mx-auto mb-4" />
                                <p>Summary will be generated after transcription</p>
                              </div>
                            )}
                          </motion.div>
                        )}

                        {activeTab === 'apod' && (
                          <motion.div 
                            key="apod"
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -10 }}
                            className="max-w-4xl mx-auto space-y-6"
                          >
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              {selectedRecording.apod_results?.map((res, i) => (
                                <div key={i} className={`p-6 rounded-2xl border ${res.engaged ? 'bg-red-500/5 border-red-500/20' : 'bg-green-500/5 border-green-500/20'}`}>
                                  <div className="flex items-center justify-between mb-4">
                                    <h3 className="font-bold text-sm">{res.pattern}</h3>
                                    <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded ${res.engaged ? 'bg-red-500 text-white' : 'bg-green-500 text-white'}`}>
                                      {res.engaged ? 'Engaged' : 'Not Found'}
                                    </span>
                                  </div>
                                  <p className="text-xs text-white/60 mb-4 leading-relaxed">{res.explanation}</p>
                                  {res.evidence && (
                                    <div className="p-3 bg-black/40 rounded-lg border border-white/5 italic text-xs text-white/40">
                                      "{res.evidence}"
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center opacity-20">
                    <FileAudio size={64} strokeWidth={1} />
                    <p className="mt-4 text-lg font-light">Select a recording to view details</p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
