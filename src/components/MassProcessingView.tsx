import React, { useState } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  Upload,
  Loader2,
  FileAudio,
  FileVideo,
  Search,
  CheckCircle2,
  AlertCircle,
  Download,
  RotateCcw,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format } from 'date-fns';
import { apiFetch } from '../services/apiClient';
import { deleteRemoteTranscript, generateReportOnServer, releaseTranscriptJob, searchKeywords, transcribeOnServer } from '../services/reportClient';
import { pollWithBackoff } from '../services/polling';
import { mapPool } from '../services/concurrency';
import { getElectron } from '../electron-bridge';
import { ReportBody } from './ReportBody';
import { formatReportFooter, type AuditFields } from '../services/audit';

interface MassProcessingViewProps {
  mode: 'mass-jail-call' | 'mass-keyword-search';
  preferAssemblySummary?: boolean;
  allowGemini?: boolean;
  gatewayModel?: string;
  hasAssemblyKey?: boolean;
  hasGeminiKey?: boolean;
  massConcurrency?: number;
  jailCallQueue?: boolean;
  jailCallTranscribe?: boolean;
  jailCallSummarize?: boolean;
  keywordBoost?: boolean;
  keywordTranscribe?: boolean;
  keywordContext?: boolean;
  aiAcknowledgedAt?: string | null;
}

interface ProcessedFile {
  id: string;
  name: string;
  file?: File;
  path?: string;
  status: 'pending' | 'uploading' | 'converting' | 'transcribing' | 'summarizing' | 'completed' | 'error';
  progress: number;
  message?: string;
  serverFilename?: string;
  serverReady?: boolean;
  error?: string;
  summary?: string;
  reportMeta?: AuditFields | null;
  truncated?: boolean;
  deletionNote?: string;
  keywordResults?: {
    keyword: string;
    context: string;
    start: string;
    confidence: number;
  }[];
}

const CONVERSION_TIMEOUT_MS = 30 * 60 * 1000;

export const MassProcessingView: React.FC<MassProcessingViewProps> = ({
  mode,
  preferAssemblySummary,
  allowGemini,
  gatewayModel,
  hasAssemblyKey,
  hasGeminiKey,
  massConcurrency = 2,
  jailCallTranscribe = true,
  jailCallSummarize = true,
  keywordBoost = true,
  keywordTranscribe = true,
  keywordContext = true,
  aiAcknowledgedAt,
}) => {
  const [files, setFiles] = useState<ProcessedFile[]>([]);
  const [keywords, setKeywords] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const onDrop = (acceptedFiles: File[]) => {
    const electron = getElectron();
    const newFiles = acceptedFiles.map(file => {
      let filePath = '';
      try { filePath = electron?.pathForFile?.(file) || ''; } catch { filePath = ''; }
      return {
        id: Math.random().toString(36).slice(2, 11),
        name: file.name,
        status: 'pending' as const,
        progress: 0,
        path: filePath || undefined,
        file: filePath ? undefined : file,
      };
    });
    setFiles(prev => [...prev, ...newFiles]);
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.wma', '.mp2', '.amr'],
      'video/*': ['.mp4', '.mov', '.mpg', '.mpeg', '.avi', '.mkv', '.wmv', '.webm', '.3gp', '.ts', '.m2ts'],
    },
    multiple: true,
  });

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const patchFile = (id: string, patch: Partial<ProcessedFile>) => {
    setFiles(prev => prev.map(f => (f.id === id ? { ...f, ...patch } : f)));
  };

  const processOne = async (fileObj: ProcessedFile, engine: 'gateway' | 'gemini') => {
    const keywordsList = keywords.split(',').map(k => k.trim()).filter(Boolean);
    patchFile(fileObj.id, { status: 'uploading', progress: 8, error: undefined, message: 'Uploading to this computer…' });

    let uploadData: any;
    if (fileObj.serverReady && fileObj.serverFilename) {
      uploadData = {
        filename: fileObj.serverFilename,
        transcriptionFilename: fileObj.serverFilename,
        status: 'ready',
      };
      patchFile(fileObj.id, { status: 'transcribing', progress: 30, message: 'Retrying upload to AssemblyAI…' });
    } else if (fileObj.path) {
      const allowed = await getElectron()?.allowPath?.(fileObj.path);
      if (!allowed?.ok) throw new Error(allowed?.error || 'Could not use that file path.');
      uploadData = await apiFetch('/api/upload/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fileObj.path }),
      });
    } else if (fileObj.file) {
      const formData = new FormData();
      formData.append('file', fileObj.file);
      uploadData = await apiFetch('/api/upload', { method: 'POST', body: formData });
    } else {
      throw new Error('That file is no longer available.');
    }

    if (uploadData.status === 'converting') {
      patchFile(fileObj.id, { status: 'converting', progress: 15, message: 'Converting audio…' });
      await pollWithBackoff({
        initialDelayMs: 1000,
        maxDelayMs: 8000,
        timeoutMs: CONVERSION_TIMEOUT_MS,
        poll: () => apiFetch(`/api/jobs/${uploadData.jobId}/progress`),
        isDone: (value) => value.status === 'completed' || Number(value.progress) >= 100,
        onUpdate: (value) => {
          const progressValue = Number(value.progress) || 0;
          patchFile(fileObj.id, { progress: 15 + progressValue * 0.15, message: 'Converting audio…' });
        },
        onTransientError: (_error, attempt, maxAttempts) => {
          patchFile(fileObj.id, { message: `Reconnecting to the local server (${attempt}/${maxAttempts})…` });
        },
      });
    }

    const storedName = uploadData.transcriptionFilename || uploadData.filename;
    if (storedName) {
      fileObj.serverFilename = storedName;
      fileObj.serverReady = true;
      fileObj.file = undefined;
      patchFile(fileObj.id, { serverFilename: storedName, serverReady: true, file: undefined });
    }

    const shouldTranscribe = mode === 'mass-jail-call' ? jailCallTranscribe : keywordTranscribe;
    let transcriptData: any = { text: 'Transcription skipped.', words: [] as any[], utterances: [] as any[] };

    if (shouldTranscribe) {
      if (!hasAssemblyKey) throw new Error('Add an AssemblyAI API key in Settings.');
      if (engine === 'gemini' && (!allowGemini || preferAssemblySummary)) {
        throw new Error('Google Gemini is turned off, so this recording was not sent to Google.');
      }
      const fileToTranscribe = uploadData.transcriptionFilename || uploadData.filename;
      const keyterms = mode === 'mass-keyword-search' && keywordBoost ? keywordsList : undefined;
      const transcribed = await transcribeOnServer({
        filename: fileToTranscribe,
        speakersExpected: mode === 'mass-jail-call' ? 2 : undefined,
        keyterms,
        includeBuiltinSummary: false,
        onProgress: (message, progress) => {
          patchFile(fileObj.id, {
            status: 'transcribing',
            progress: Math.max(30, Math.min(80, progress || 40)),
            message,
          });
        },
      });
      transcriptData = { id: transcribed.transcriptId, jobId: transcribed.jobId };
    }

    if (mode === 'mass-jail-call') {
      if (jailCallSummarize && shouldTranscribe) {
        patchFile(fileObj.id, { status: 'summarizing', progress: 88, message: engine === 'gemini' ? 'Writing the report with Gemini…' : 'Writing the report…' });
        const result = await generateReportOnServer({
          transcriptJobId: transcriptData.jobId,
          reportType: 'Jail Phone Calls',
          caseInfo: { recordingName: fileObj.name, reportType: 'Jail Phone Calls' },
          model: gatewayModel,
          engine,
          strictlyAssembly: preferAssemblySummary,
          aiAcknowledgedAt,
          onProgress: (message) => patchFile(fileObj.id, { status: 'summarizing', message }),
        });
        const meta: AuditFields = {
          model: result.model,
          requestId: result.requestId,
          transcriptId: result.transcriptId || transcriptData?.id || null,
          generatedAt: result.generatedAt,
          aiAcknowledgedAt: result.aiAcknowledgedAt,
          aiAcknowledgedLabel: result.aiAcknowledgedLabel,
        };
        let deletionNote = '';
        if (transcriptData?.id && !String(transcriptData.id).startsWith('local-whisper')) {
          try {
            const deleted = await deleteRemoteTranscript(String(transcriptData.id));
            deletionNote = deleted.skipped
              ? 'Remote transcript kept (deletion is turned off).'
              : deleted.ok
                ? 'Transcript removed from AssemblyAI.'
                : `AssemblyAI deletion failed: ${deleted.error || 'unknown error'}`;
          } catch (error: any) {
            deletionNote = `AssemblyAI deletion failed: ${error.message || error}`;
          }
        }
        patchFile(fileObj.id, {
          status: 'completed',
          progress: 100,
          message: 'Report ready',
          summary: result.response,
          reportMeta: meta,
          truncated: result.truncated,
          deletionNote,
        });
      } else {
        if (transcriptData?.jobId) await releaseTranscriptJob(transcriptData.jobId);
        const summaryText = shouldTranscribe
          ? 'Transcription saved. Summary generation was turned off for this batch.'
          : 'Transcription and summarization skipped.';
        patchFile(fileObj.id, { status: 'completed', progress: 100, message: 'Done', summary: summaryText });
      }
      return;
    }

    let results: ProcessedFile['keywordResults'] = [];
    if (keywordContext && shouldTranscribe && transcriptData?.jobId) {
      patchFile(fileObj.id, { status: 'summarizing', progress: 90, message: 'Searching keywords…' });
      const found = await searchKeywords(transcriptData.jobId, keywordsList);
      results = found.matches;
      transcriptData = { id: found.transcriptId || transcriptData.id };
    } else if (transcriptData?.jobId) {
      await releaseTranscriptJob(transcriptData.jobId);
    }
    let deletionNote = '';
    if (transcriptData?.id && !String(transcriptData.id).startsWith('local-whisper')) {
      try {
        const deleted = await deleteRemoteTranscript(String(transcriptData.id));
        deletionNote = deleted.skipped ? '' : deleted.ok ? 'Transcript removed from AssemblyAI.' : `AssemblyAI deletion failed: ${deleted.error || 'unknown error'}`;
      } catch (error: any) {
        deletionNote = `AssemblyAI deletion failed: ${error.message || error}`;
      }
    }
    patchFile(fileObj.id, {
      status: 'completed',
      progress: 100,
      message: 'Search complete',
      keywordResults: results,
      deletionNote,
    });
  };

  const processFiles = async (onlyId?: string, engine: 'gateway' | 'gemini' = 'gateway') => {
    if (!hasAssemblyKey && (mode === 'mass-keyword-search' ? keywordTranscribe : jailCallTranscribe)) {
      alert('Add an AssemblyAI API key in Settings.');
      return;
    }
    if (mode === 'mass-keyword-search' && !keywords.trim()) {
      alert('Enter keywords to search for.');
      return;
    }
    if (engine === 'gemini' && (!allowGemini || preferAssemblySummary || !hasGeminiKey)) {
      alert('Google Gemini is turned off, so these recordings were not sent to Google.');
      return;
    }

    setIsProcessing(true);
    const snapshot = files.filter(file => (onlyId ? file.id === onlyId : file.status !== 'completed'));
    const limit = Math.max(1, Math.min(4, massConcurrency || 2));
    await mapPool(snapshot, limit, async (fileObj) => {
      try {
        await processOne(fileObj, engine);
      } catch (error: any) {
        const message = error?.message || 'Processing failed';
        const geminiHint = engine === 'gateway' && allowGemini && !preferAssemblySummary
          ? ' AssemblyAI failed. Gemini was not used. You can retry, or send this file to Gemini if your policy allows it.'
          : '';
        patchFile(fileObj.id, { status: 'error', progress: 100, error: `${message}${geminiHint}`, message: 'Failed' });
      } finally {
        if (fileObj.serverReady) fileObj.file = undefined;
      }
    });
    setIsProcessing(false);
  };

  const exportResults = () => {
    const content = files.map(f => {
      let res = `File: ${f.name}\nStatus: ${f.status}\n`;
      if (f.error) res += `Error: ${f.error}\n`;
      if (f.summary) res += `Summary:\n${f.summary}\n`;
      if (f.reportMeta) res += `${formatReportFooter(f.reportMeta)}\n`;
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
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#0F1115] overflow-y-auto">
      <div className="p-8 max-w-5xl mx-auto w-full space-y-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">
              {mode === 'mass-jail-call' ? 'Mass Jail Call Summary' : 'Mass Keyword Search'}
            </h2>
            <p className="text-white/40 mt-1">
              {mode === 'mass-jail-call'
                ? 'Upload jail calls. Each file is transcribed with two speakers and summarized on the AssemblyAI gateway.'
                : 'Search for specific terms across multiple recordings. Audio stays on this computer until AssemblyAI transcribes it.'}
            </p>
          </div>
          {files.length > 0 && (
            <button
              onClick={exportResults}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 transition-all text-sm font-bold shrink-0"
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
            <p className="text-xs text-white/40">These terms are sent as keyterms_prompt so Universal-3.5 Pro stays selected. They are not sent as word_boost.</p>
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
            <p className="text-sm text-white/40 mt-1">Supports standard audio and video formats. Files are streamed from disk to AssemblyAI.</p>
          </div>
        </div>

        {files.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold uppercase tracking-widest text-white/40">Queue ({files.length})</h3>
              <button
                onClick={() => processFiles()}
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
                    className="bg-white/5 border border-white/10 rounded-2xl p-4"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 bg-white/5 rounded-xl flex items-center justify-center">
                        {file.name.match(/\.(mp4|mov|mpg|mkv|avi|webm)$/i) ? <FileVideo size={20} className="text-blue-400" /> : <FileAudio size={20} className="text-orange-400" />}
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
                          {file.message && file.status !== 'pending' && (
                            <span className="text-[11px] text-white/40 truncate">{file.message}</span>
                          )}
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
                        className="mt-4 pt-4 border-t border-white/5 space-y-3"
                      >
                        {mode === 'mass-jail-call' ? (
                          file.summary?.includes('## ') ? (
                            <ReportBody
                              markdown={file.summary}
                              meta={file.reportMeta}
                              truncated={file.truncated}
                              continuing={isProcessing}
                              onContinue={() => processFiles(file.id, 'gateway')}
                            />
                          ) : (
                            <pre className="text-sm text-white/70 whitespace-pre-wrap font-sans">{file.summary}</pre>
                          )
                        ) : (
                          <div className="space-y-3">
                            {file.keywordResults && file.keywordResults.length > 0 ? (
                              file.keywordResults.map((kr, i) => (
                                <div key={i} className="bg-black/20 rounded-xl p-3 border border-white/5">
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="text-[10px] font-bold uppercase tracking-widest text-orange-500">{kr.keyword}</span>
                                    <span className="text-[10px] font-mono opacity-40">{kr.start}</span>
                                  </div>
                                  <p className="text-xs text-white/60 leading-relaxed">...{kr.context}...</p>
                                </div>
                              ))
                            ) : (
                              <p className="text-xs text-white/30 italic">No keywords found in this recording.</p>
                            )}
                          </div>
                        )}
                        {file.deletionNote && <p className="text-[11px] text-white/40">{file.deletionNote}</p>}
                      </motion.div>
                    )}

                    {file.status === 'error' && (
                      <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl space-y-3">
                        <div className="flex items-start gap-3">
                          <AlertCircle size={16} className="text-red-500 mt-0.5 shrink-0" />
                          <p className="text-xs text-red-200">{file.error}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            disabled={isProcessing}
                            onClick={() => processFiles(file.id, 'gateway')}
                            className="px-3 py-1.5 rounded-lg bg-white text-black text-xs font-bold inline-flex items-center gap-1"
                          >
                            <RotateCcw size={12} /> Retry upload
                          </button>
                          {allowGemini && !preferAssemblySummary && hasGeminiKey && (
                            <button
                              disabled={isProcessing}
                              onClick={() => processFiles(file.id, 'gemini')}
                              className="px-3 py-1.5 rounded-lg bg-white/10 text-xs font-bold"
                            >
                              Send to Gemini instead
                            </button>
                          )}
                        </div>
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
