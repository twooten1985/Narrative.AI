import React, { useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { 
  Upload, 
  Loader2, 
  FileAudio, 
  FileVideo, 
  Search, 
  FileText, 
  CheckCircle2, 
  AlertCircle,
  Download
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { generateSummary } from '../services/geminiService';
import { format } from 'date-fns';

interface MassProcessingViewProps {
  mode: 'mass-jail-call' | 'mass-keyword-search';
  assemblyKey: string;
}

interface ProcessedFile {
  id: string;
  name: string;
  status: 'pending' | 'uploading' | 'transcribing' | 'summarizing' | 'completed' | 'error';
  progress: number;
  error?: string;
  summary?: string;
  keywordResults?: {
    keyword: string;
    context: string;
    start: string;
    confidence: number;
  }[];
}

export const MassProcessingView: React.FC<MassProcessingViewProps> = ({ mode, assemblyKey }) => {
  const [files, setFiles] = useState<ProcessedFile[]>([]);
  const [keywords, setKeywords] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const onDrop = (acceptedFiles: File[]) => {
    const newFiles = acceptedFiles.map(file => ({
      id: Math.random().toString(36).substr(2, 9),
      name: file.name,
      status: 'pending' as const,
      progress: 0,
      file
    }));
    setFiles(prev => [...prev, ...newFiles]);
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ 
    onDrop,
    accept: {
      'audio/*': ['.mp3', '.wav', '.m4a'],
      'video/*': ['.mp4', '.mov', '.mpg']
    }
  });

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const processFiles = async () => {
    if (!assemblyKey) {
      alert("Please provide an AssemblyAI API Key in settings.");
      return;
    }
    if (mode === 'mass-keyword-search' && !keywords) {
      alert("Please provide keywords to search for.");
      return;
    }

    setIsProcessing(true);
    const keywordsList = keywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k);

    for (const fileObj of files) {
      if (fileObj.status === 'completed') continue;

      try {
        // 1. Upload to our server
        setFiles(prev => prev.map(f => f.id === fileObj.id ? { ...f, status: 'uploading', progress: 15 } : f));
        const formData = new FormData();
        formData.append('file', (fileObj as any).file);
        
        const uploadRes = await fetch('/api/upload', {
          method: 'POST',
          body: formData
        });
        const uploadData = await uploadRes.json();
        if (!uploadRes.ok) throw new Error(uploadData.error || "Server upload failed");

        // 2. Upload to AssemblyAI
        setFiles(prev => prev.map(f => f.id === fileObj.id ? { ...f, status: 'transcribing', progress: 30 } : f));
        const fileToTranscribe = uploadData.transcriptionFilename || uploadData.filename;
        const fileBlobRes = await fetch(`/uploads/${fileToTranscribe}`);
        const blob = await fileBlobRes.blob();

        const aaiUploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
          method: 'POST',
          headers: { 'authorization': assemblyKey },
          body: blob
        });
        const aaiUploadData = await aaiUploadRes.json();
        if (!aaiUploadRes.ok) throw new Error(aaiUploadData.error || "AssemblyAI upload failed");

        // 3. Start transcription
        setFiles(prev => prev.map(f => f.id === fileObj.id ? { ...f, progress: 45 } : f));
        const transcriptRes = await fetch('https://api.assemblyai.com/v2/transcript', {
          method: 'POST',
          headers: {
            'authorization': assemblyKey,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            audio_url: aaiUploadData.upload_url,
            word_boost: mode === 'mass-keyword-search' ? keywordsList : undefined
          })
        });
        let transcriptData = await transcriptRes.json();
        if (!transcriptRes.ok) throw new Error(transcriptData.error || "Transcription start failed");

        // 4. Poll
        while (transcriptData.status !== 'completed' && transcriptData.status !== 'error') {
          await new Promise(r => setTimeout(r, 3000));
          const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptData.id}`, {
            headers: { 'authorization': assemblyKey }
          });
          transcriptData = await pollRes.json();
          
          // Increment progress slightly while polling
          setFiles(prev => prev.map(f => {
            if (f.id === fileObj.id) {
              const nextProgress = Math.min(85, f.progress + 5);
              return { ...f, progress: nextProgress };
            }
            return f;
          }));
        }

        if (transcriptData.status === 'error') throw new Error(transcriptData.error || "Transcription failed");

        // 5. Process results
        if (mode === 'mass-jail-call') {
          setFiles(prev => prev.map(f => f.id === fileObj.id ? { ...f, status: 'summarizing', progress: 90 } : f));
          const summary = await generateSummary(transcriptData.text, "Jail Phone Calls");
          setFiles(prev => prev.map(f => f.id === fileObj.id ? { ...f, status: 'completed', progress: 100, summary } : f));
        } else {
          setFiles(prev => prev.map(f => f.id === fileObj.id ? { ...f, status: 'summarizing', progress: 90 } : f));
          const results: any[] = [];
          const words = transcriptData.words || [];
          const windowSize = 10;

          words.forEach((word: any, index: number) => {
            if (keywordsList.includes(word.text.toLowerCase())) {
              const startIdx = Math.max(0, index - windowSize);
              const endIdx = Math.min(words.length, index + windowSize + 1);
              const context = words.slice(startIdx, endIdx).map((w: any) => w.text).join(' ');
              
              results.push({
                keyword: word.text,
                context,
                start: formatTime(word.start),
                confidence: word.confidence
              });
            }
          });

          setFiles(prev => prev.map(f => f.id === fileObj.id ? { ...f, status: 'completed', progress: 100, keywordResults: results } : f));
        }

      } catch (error: any) {
        console.error(`Error processing ${fileObj.name}:`, error);
        setFiles(prev => prev.map(f => f.id === fileObj.id ? { ...f, status: 'error', progress: 100, error: error.message } : f));
      }
    }
    setIsProcessing(false);
  };

  const exportResults = () => {
    const content = files.map(f => {
      let res = `File: ${f.name}\nStatus: ${f.status}\n`;
      if (f.error) res += `Error: ${f.error}\n`;
      if (f.summary) res += `Summary: ${f.summary}\n`;
      if (f.keywordResults) {
        f.keywordResults.forEach(kr => {
          res += `Keyword: ${kr.keyword}\nContext: ${kr.context}\nTimestamp: ${kr.start}\nConfidence: ${kr.confidence}\n\n`;
        });
      }
      return res + '\n' + '-'.repeat(40) + '\n';
    }).join('\n');

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${mode}_report_${format(new Date(), 'yyyy-MM-dd_HH-mm')}.txt`;
    a.click();
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#0F1115] overflow-y-auto">
      <div className="p-8 max-w-5xl mx-auto w-full space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">
              {mode === 'mass-jail-call' ? 'Mass Jail Call Summary' : 'Mass Keyword Search'}
            </h2>
            <p className="text-white/40 mt-1">
              {mode === 'mass-jail-call' 
                ? 'Upload multiple jail calls to generate automated summaries for each.' 
                : 'Search for specific terms across multiple recordings simultaneously.'}
            </p>
          </div>
          {files.length > 0 && (
            <button 
              onClick={exportResults}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 transition-all text-sm font-bold"
            >
              <Download size={18} />
              Export Report
            </button>
          )}
        </div>

        {mode === 'mass-keyword-search' && (
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
            <label className="text-xs font-bold uppercase tracking-widest text-white/40">Keywords (comma separated)</label>
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20" size={18} />
              <input 
                value={keywords}
                onChange={e => setKeywords(e.target.value)}
                placeholder="e.g. drugs, money, lawyer, witness"
                className="w-full bg-black/20 border border-white/10 rounded-xl pl-12 pr-4 py-3 text-sm focus:border-orange-500 transition-colors outline-none"
              />
            </div>
          </div>
        )}

        <div 
          {...getRootProps()} 
          className={`border-2 border-dashed rounded-3xl p-12 transition-all flex flex-col items-center justify-center gap-4 cursor-pointer
            ${isDragActive ? 'border-orange-500 bg-orange-500/5' : 'border-white/10 hover:border-white/20 hover:bg-white/5'}`}
        >
          <input {...getInputProps()} />
          <div className="w-16 h-16 bg-orange-500/10 rounded-2xl flex items-center justify-center">
            <Upload size={32} className="text-orange-500" />
          </div>
          <div className="text-center">
            <p className="text-lg font-medium">Click or drag files to upload</p>
            <p className="text-sm text-white/40 mt-1">Supports MP3, WAV, M4A, MP4, MOV</p>
          </div>
        </div>

        {files.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold uppercase tracking-widest text-white/40">Queue ({files.length})</h3>
              <button 
                onClick={processFiles}
                disabled={isProcessing}
                className="px-6 py-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 rounded-xl font-bold text-sm transition-all flex items-center gap-2"
              >
                {isProcessing ? <Loader2 className="animate-spin" size={18} /> : <CheckCircle2 size={18} />}
                {isProcessing ? 'Processing...' : 'Start Processing'}
              </button>
            </div>

            <div className="grid gap-4">
              <AnimatePresence>
                {files.map(file => (
                  <motion.div 
                    key={file.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-white/5 border border-white/10 rounded-2xl p-4 overflow-hidden"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 bg-white/5 rounded-xl flex items-center justify-center">
                        {file.name.match(/\.(mp4|mov|mpg)$/i) ? <FileVideo size={20} className="text-blue-400" /> : <FileAudio size={20} className="text-orange-400" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{file.name}</p>
                        <div className="flex items-center gap-3 mt-1">
                          <span className={`text-[10px] font-bold uppercase tracking-widest
                            ${file.status === 'completed' ? 'text-green-500' : 
                              file.status === 'error' ? 'text-red-500' : 
                              file.status === 'pending' ? 'text-white/30' : 'text-orange-500'}`}
                          >
                            {file.status}
                          </span>
                          {file.status !== 'pending' && file.status !== 'completed' && file.status !== 'error' && (
                            <Loader2 size={10} className="animate-spin text-orange-500" />
                          )}
                        </div>
                      </div>
                    </div>

                    {file.status !== 'pending' && (
                      <div className="mt-4 h-1 bg-white/5 rounded-full overflow-hidden">
                        <motion.div 
                          initial={{ width: 0 }}
                          animate={{ width: `${file.progress}%` }}
                          className={`h-full transition-all duration-500 ${file.status === 'error' ? 'bg-red-500' : file.status === 'completed' ? 'bg-green-500' : 'bg-orange-500'}`}
                        />
                      </div>
                    )}

                    {file.status === 'completed' && (
                      <motion.div 
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="mt-4 pt-4 border-t border-white/5"
                      >
                        {mode === 'mass-jail-call' ? (
                          <div className="text-sm text-white/70 leading-relaxed italic">
                            {file.summary}
                          </div>
                        ) : (
                          <div className="space-y-3">
                            {file.keywordResults && file.keywordResults.length > 0 ? (
                              file.keywordResults.map((kr, i) => (
                                <div key={i} className="bg-black/20 rounded-xl p-3 border border-white/5">
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="text-[10px] font-bold uppercase tracking-widest text-orange-500">{kr.keyword}</span>
                                    <span className="text-[10px] font-mono opacity-40">{kr.start}</span>
                                  </div>
                                  <p className="text-xs text-white/60 leading-relaxed">
                                    ...{kr.context}...
                                  </p>
                                </div>
                              ))
                            ) : (
                              <p className="text-xs text-white/30 italic">No keywords found in this recording.</p>
                            )}
                          </div>
                        )}
                      </motion.div>
                    )}

                    {file.status === 'error' && (
                      <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3">
                        <AlertCircle size={16} className="text-red-500" />
                        <p className="text-xs text-red-500">{file.error}</p>
                      </div>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
