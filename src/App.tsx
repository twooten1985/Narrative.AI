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
  Download,
  AlertCircle,
  RotateCcw,
  Search,
  Copy,
  Check,
  Printer,
  Maximize2,
  Minimize2,
  Calendar,
  Sparkles
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format } from 'date-fns';
import { useDropzone } from 'react-dropzone';
import { saveAs } from 'file-saver';
import { Case, Recording, ReportMeta, Word } from './types';
import { INTERVIEW_PROMPTS } from './services/geminiService';
import { MassProcessingView } from './components/MassProcessingView';
import { StatsView } from './components/StatsView';
import { ReportBody } from './components/ReportBody';
import { TranscriptList } from './components/TranscriptList';
import { AiAcknowledgementModal, type SessionAcknowledgement } from './components/AiAcknowledgementModal';
import { SpeakerNamePanel } from './components/SpeakerNamePanel';
import { apiFetch, initApiSession } from './services/apiClient';
import { deleteRemoteTranscript, generateReportOnServer, transcribeLocally, transcribeOnServer } from './services/reportClient';
import { pollWithBackoff } from './services/polling';
import { buildPrintableReportHtml } from './services/reportHtml';
import { reportToDocxBlob } from './services/reportDocx';
import { AI_DISCLAIMER, formatAuditLine, formatGeneratedAt } from './services/audit';
import { extractFinalSummary, finalSummaryClipboard, markdownToPlain } from './services/finalSummary';
import { getElectron } from './electron-bridge';
import { APP_VERSION } from './version';
import { DEFAULT_AAI_API_BASE, DEFAULT_LLM_GATEWAY_URL } from './services/config';

export const getAssemblyAISummary = (transcript: any): string => {
  if (transcript?.speech_understanding?.response?.summarization?.status === 'success') {
    const topics = transcript.speech_understanding.response.summarization.summary;
    if (Array.isArray(topics)) {
      return topics.map((t: any) => `### ${t.headline}\n${t.text}`).join('\n\n');
    }
  }
  return transcript?.summary || "";
};

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0F1115] flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white/5 border border-white/10 rounded-3xl p-8 text-center space-y-6">
            <div className="w-16 h-16 bg-red-500/10 rounded-2xl flex items-center justify-center mx-auto">
              <AlertCircle size={32} className="text-red-500" />
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-bold text-white">Something went wrong</h2>
              <p className="text-sm text-white/40">
                The application encountered an unexpected error. Please try refreshing the page.
              </p>
            </div>
            {this.state.error && (
              <div className="p-4 bg-black/40 rounded-xl text-left overflow-auto max-h-40">
                <code className="text-xs text-red-400 font-mono break-all">
                  {this.state.error.message}
                </code>
              </div>
            )}
            <button 
              onClick={() => window.location.reload()}
              className="w-full py-3 bg-white text-black rounded-xl font-bold hover:bg-white/90 transition-colors"
            >
              Refresh Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

function AppContent() {
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
  const [hasAssemblyKey, setHasAssemblyKey] = useState(false);
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [allowGemini, setAllowGemini] = useState(false);
  const [deleteRemoteTranscripts, setDeleteRemoteTranscripts] = useState(true);
  const [officerName, setOfficerName] = useState('');
  const [officerBadge, setOfficerBadge] = useState('');
  const [aaiApiBase, setAaiApiBase] = useState(DEFAULT_AAI_API_BASE);
  const [llmGatewayUrl, setLlmGatewayUrl] = useState(DEFAULT_LLM_GATEWAY_URL);
  const [chunkTokenLimit, setChunkTokenLimit] = useState(100000);
  const [massConcurrency, setMassConcurrency] = useState(2);
  const [preferAssemblySummary, setPreferAssemblySummary] = useState(localStorage.getItem('prefer_assembly_summary') === 'true');
  const [reportError, setReportError] = useState<string | null>(null);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [timelineMeta, setTimelineMeta] = useState<ReportMeta | null>(null);
  const [cleanMessage, setCleanMessage] = useState<string | null>(null);
  const [isCleaning, setIsCleaning] = useState(false);
  const [keyTestMessage, setKeyTestMessage] = useState<string | null>(null);
  const [isTestingKeys, setIsTestingKeys] = useState(false);
  const [regressMessage, setRegressMessage] = useState<string | null>(null);
  const [isRegressing, setIsRegressing] = useState(false);
  const [appReady, setAppReady] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speakerLabels, setSpeakerLabels] = useState<Record<string, string>>({});
  const [interviewType, setInterviewType] = useState<string>("Suspect Interview");

  const [mediaError, setMediaError] = useState<string | null>(null);
  const [useAudioFallback, setUseAudioFallback] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDeletingCase, setIsDeletingCase] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [tempAssemblyKey, setTempAssemblyKey] = useState('');
  const [tempGeminiKey, setTempGeminiKey] = useState('');
  const [tempAllowGemini, setTempAllowGemini] = useState(false);
  const [tempDeleteRemote, setTempDeleteRemote] = useState(true);
  const [tempOfficerName, setTempOfficerName] = useState('');
  const [tempOfficerBadge, setTempOfficerBadge] = useState('');
  const [tempApiBase, setTempApiBase] = useState(DEFAULT_AAI_API_BASE);
  const [tempGatewayUrl, setTempGatewayUrl] = useState(DEFAULT_LLM_GATEWAY_URL);
  const [tempChunkLimit, setTempChunkLimit] = useState('100000');
  const [tempMassConcurrency, setTempMassConcurrency] = useState('2');
  const [tempPreferAssembly, setTempPreferAssembly] = useState(preferAssemblySummary);
  const [gatewayModel, setGatewayModel] = useState<string>(localStorage.getItem('gateway_model') || 'claude-sonnet-4-6');
  const [tempGatewayModel, setTempGatewayModel] = useState<string>(gatewayModel);
  const [localWhisperMode, setLocalWhisperMode] = useState<boolean>(localStorage.getItem('local_whisper_mode') === 'true');
  const [tempLocalWhisper, setTempLocalWhisper] = useState<boolean>(localWhisperMode);
  const [timelineReport, setTimelineReport] = useState<string | null>(null);
  const [isGeneratingTimeline, setIsGeneratingTimeline] = useState<boolean>(false);
  const [isEditingTimeline, setIsEditingTimeline] = useState<boolean>(false);
  const [tempTimelineReport, setTempTimelineReport] = useState<string>('');
  const [isRegenConfirmOpen, setIsRegenConfirmOpen] = useState(false);
  const [tempRegenType, setTempRegenType] = useState('Suspect Interview');
  const [infoModalMode, setInfoModalMode] = useState<'mass-jail-call' | 'mass-keyword-search' | null>(null);
  const [jailCallQueue, setJailCallQueue] = useState(true);
  const [jailCallTranscribe, setJailCallTranscribe] = useState(true);
  const [jailCallSummarize, setJailCallSummarize] = useState(true);
  const [keywordBoost, setKeywordBoost] = useState(true);
  const [keywordTranscribe, setKeywordTranscribe] = useState(true);
  const [keywordContext, setKeywordContext] = useState(true);
  const [topHeight, setTopHeight] = useState(400);
  const [isResizing, setIsResizing] = useState(false);
  const [mode, setMode] = useState<'cases' | 'mass-jail-call' | 'mass-keyword-search' | 'statistics'>('cases');
  const [isConverting, setIsConverting] = useState(false);
  const [conversionProgress, setConversionProgress] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [isRegeneratingSummary, setIsRegeneratingSummary] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [finalCopySuccess, setFinalCopySuccess] = useState(false);
  const [aiAck, setAiAck] = useState<SessionAcknowledgement | null>(null);
  const [summaryFilter, setSummaryFilter] = useState('');
  const [isSummaryExpanded, setIsSummaryExpanded] = useState(false);

  const [customPrompts, setCustomPrompts] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('custom_prompts') || '{}');
    } catch (e) {
      return {};
    }
  });
  const [newPromptName, setNewPromptName] = useState('');
  const [newPromptText, setNewPromptText] = useState('');

  const handleAddPrompt = () => {
    if (!newPromptName.trim() || !newPromptText.trim()) {
      alert("Please enter both a title and prompt text.");
      return;
    }
    const name = newPromptName.trim();
    if (name in INTERVIEW_PROMPTS) {
      alert("Cannot overwrite default interview prompts.");
      return;
    }
    const updated = { ...customPrompts, [name]: newPromptText.trim() };
    setCustomPrompts(updated);
    localStorage.setItem('custom_prompts', JSON.stringify(updated));
    setNewPromptName('');
    setNewPromptText('');
  };

  const handleDeletePrompt = (name: string) => {
    const updated = { ...customPrompts };
    delete updated[name];
    setCustomPrompts(updated);
    localStorage.setItem('custom_prompts', JSON.stringify(updated));
    if (interviewType === name) {
      setInterviewType("Suspect Interview");
    }
  };

  const mediaRef = useRef<HTMLMediaElement>(null);

  const copyToClipboard = async (text: string) => {
    const electron = (window as any).electron;
    if (electron?.writeClipboardText) {
      try {
        if (electron.writeClipboardText(text) !== false) return true;
      } catch (err) {
        console.error("Clipboard copy failed:", err);
      }
    }
    if (!navigator.clipboard?.writeText) return false;
    try {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard timeout")), 800)),
      ]);
      return true;
    } catch (err) {
      console.error("Clipboard copy failed:", err);
      return false;
    }
  };

  const handleCopyFinalSummary = async () => {
    if (!selectedRecording?.summary) return;
    const plain = finalSummaryClipboard(selectedRecording.summary, selectedRecording.report_meta?.aiAcknowledgedLabel);
    if (!plain) {
      alert('This report has no Final Summary yet. Regenerate the narrative to add one.');
      return;
    }
    const success = await copyToClipboard(plain);
    if (success) {
      setFinalCopySuccess(true);
      window.setTimeout(() => setFinalCopySuccess(false), 2000);
    } else {
      alert('Failed to copy the Final Summary.');
    }
  };

  const handleCopySummary = async () => {
    if (!selectedRecording?.summary) return;
    const success = await copyToClipboard(selectedRecording.summary);
    if (success) {
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } else {
      alert("Failed to copy text to clipboard.");
    }
  };

  const currentAudit = (meta?: ReportMeta | null) => formatAuditLine({
    model: meta?.model,
    requestId: meta?.requestId,
    transcriptId: meta?.transcriptId,
    generatedAt: meta?.generatedAt,
  });

  const printableHtml = (summary: string, meta?: ReportMeta | null) => buildPrintableReportHtml({
    caseName: selectedCase?.name,
    recordingName: selectedRecording?.original_name,
    interviewType: selectedRecording?.interview_type || interviewType,
    reportDate: formatGeneratedAt(meta?.generatedAt) === 'Unknown'
      ? format(new Date(), 'yyyy-MM-dd HH:mm:ss')
      : formatGeneratedAt(meta?.generatedAt),
    officerName,
    officerBadge,
    markdown: summary,
    auditLine: currentAudit(meta),
    acknowledgement: meta?.aiAcknowledgedLabel,
  });

  const handlePrintReport = () => {
    if (!selectedRecording?.summary) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert("Please allow popups in your browser to print official reports.");
      return;
    }
    printWindow.document.write(printableHtml(selectedRecording.summary, selectedRecording.report_meta));
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
    }, 400);
  };

  const handleExportPdf = async () => {
    if (!selectedRecording?.summary) return;
    const electron = getElectron();
    if (!electron) {
      alert("PDF export uses the desktop app. Use Print to save a PDF from the browser preview.");
      return;
    }
    const meta = selectedRecording.report_meta;
    const officer = [officerName, officerBadge ? `#${officerBadge}` : ''].filter(Boolean).join(' ');
    const headerText = [`Case: ${selectedCase?.name || 'Untitled case'}`, officer, formatGeneratedAt(meta?.generatedAt)].filter(Boolean).join('   |   ');
    const result = await electron.exportPdf({
      html: printableHtml(selectedRecording.summary, meta),
      defaultFilename: `${selectedCase?.name || 'case'}_${selectedRecording.original_name}.pdf`,
      footerNote: [AI_DISCLAIMER, meta?.aiAcknowledgedLabel].filter(Boolean).join(' '),
      auditLine: currentAudit(meta),
      headerText,
    });
    if (result?.error) alert(`PDF export failed: ${result.error}`);
  };

  const highlightText = (text: string, query: string) => {
    if (!query.trim()) return text;
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = text.split(regex);
    return (
      <>
        {parts.map((part, i) => 
          part.toLowerCase() === query.toLowerCase() ? (
            <mark key={i} className="bg-orange-500 text-white rounded-sm px-0.5">{part}</mark>
          ) : (
            part
          )
        )}
      </>
    );
  };

  const recursiveHighlight = (children: React.ReactNode): React.ReactNode => {
    if (!summaryFilter.trim()) return children;
    return React.Children.map(children, (child) => {
      if (typeof child === 'string') {
        return highlightText(child, summaryFilter);
      }
      if (React.isValidElement(child)) {
        const element = child as React.ReactElement<any>;
        if (element.props && element.props.children) {
          return React.cloneElement(element, {
            ...element.props,
            children: recursiveHighlight(element.props.children)
          });
        }
      }
      return child;
    });
  };

  const markdownComponents = {
    p: ({ children }: any) => <p>{recursiveHighlight(children)}</p>,
    li: ({ children }: any) => <li>{recursiveHighlight(children)}</li>,
    h1: ({ children }: any) => <h1>{recursiveHighlight(children)}</h1>,
    h2: ({ children }: any) => <h2>{recursiveHighlight(children)}</h2>,
    h3: ({ children }: any) => <h3>{recursiveHighlight(children)}</h3>,
    h4: ({ children }: any) => <h4>{recursiveHighlight(children)}</h4>,
    h5: ({ children }: any) => <h5>{recursiveHighlight(children)}</h5>,
    h6: ({ children }: any) => <h6>{recursiveHighlight(children)}</h6>,
    strong: ({ children }: any) => <strong>{recursiveHighlight(children)}</strong>,
    em: ({ children }: any) => <em>{recursiveHighlight(children)}</em>,
    span: ({ children }: any) => <span>{recursiveHighlight(children)}</span>,
    td: ({ children }: any) => <td>{recursiveHighlight(children)}</td>,
    th: ({ children }: any) => <th>{recursiveHighlight(children)}</th>,
    a: ({ children, href }: any) => <a href={href} target="_blank" rel="noopener noreferrer">{recursiveHighlight(children)}</a>,
  };

  useEffect(() => {
    setMediaError(null);
    setUseAudioFallback(false);
  }, [selectedRecording]);

  useEffect(() => {
    setTranscriptionError(null);
  }, [selectedRecording?.id]);

  const handleMediaError = (e: React.SyntheticEvent<HTMLMediaElement, Event>) => {
    const target = e.currentTarget;
    const error = target.error;
    let message = "Unknown media error";
    
    if (error) {
      switch (error.code) {
        case 1: message = "Fetching process aborted by user"; break;
        case 2: message = "Network error"; break;
        case 3: message = "Decoding error"; break;
        case 4: message = "Source not supported"; break;
      }
    }

    console.error(`Media error (${target.tagName}): ${message}`, error?.code);
    setMediaError(message);

    // If it's a video or wav and we have a transcription (audio) file, try falling back to it
    const isVideo = selectedRecording?.mime_type.startsWith('video');
    const isWav = selectedRecording?.mime_type.includes('wav') || selectedRecording?.filename.toLowerCase().endsWith('.wav');
    
    if ((isVideo || isWav) && selectedRecording?.transcription_filename && !useAudioFallback) {
      console.log("Attempting audio fallback for media...");
      setUseAudioFallback(true);
      setMediaError(null); // Clear error for the fallback attempt
    } else if ((isVideo || isWav) && !isConverting) {
      // If we don't have a transcription file yet, offer to convert it
      // Or just start it automatically
      handleStartConversion();
    }
  };

  const handleStartConversion = async () => {
    if (!selectedRecording) return;
    setIsConverting(true);
    setConversionProgress(0);
    try {
      await apiFetch(`/api/recordings/${selectedRecording.id}/convert`, { method: 'POST' });
      await pollWithBackoff({
        initialDelayMs: 1000,
        maxDelayMs: 8000,
        timeoutMs: 30 * 60 * 1000,
        poll: () => apiFetch(`/api/recordings/${selectedRecording.id}/convert/progress`),
        isDone: (data) => data.status === 'completed',
        onUpdate: (data) => setConversionProgress(Number(data.progress) || 0),
      });
      setIsConverting(false);
      setMediaError(null);
      await fetchCaseDetails(selectedCase!.id);
      const updatedRec = await apiFetch(`/api/recordings/${selectedRecording.id}`);
      setSelectedRecording(updatedRec);
    } catch (error) {
      console.error("Conversion failed:", error);
      setIsConverting(false);
    }
  };

  const applyServerSettings = (settings: any) => {
    setAllowGemini(settings.allowGemini === true);
    setDeleteRemoteTranscripts(settings.deleteRemoteTranscripts !== false);
    setOfficerName(settings.officerName || '');
    setOfficerBadge(settings.officerBadge || '');
    setAaiApiBase(settings.aaiApiBase || DEFAULT_AAI_API_BASE);
    setLlmGatewayUrl(settings.llmGatewayUrl || DEFAULT_LLM_GATEWAY_URL);
    setChunkTokenLimit(Number(settings.chunkTokenLimit) || 100000);
    setMassConcurrency(Number(settings.massConcurrency) || 2);
    setHasAssemblyKey(Boolean(settings.hasAssemblyKey));
    setHasGeminiKey(Boolean(settings.hasGeminiKey));
  };

  useEffect(() => {
    (async () => {
      try {
        await initApiSession();
        const electron = getElectron();
        if (electron) {
          const storedAssembly = localStorage.getItem('assembly_ai_key');
          const storedGemini = localStorage.getItem('gemini_api_key');
          if (storedAssembly) {
            if (!(await electron.secrets.hasKey('assemblyai'))) {
              const saved = await electron.secrets.setKey('assemblyai', storedAssembly);
              if (!saved.ok) throw new Error(saved.error || 'Could not migrate the AssemblyAI key.');
            }
            localStorage.removeItem('assembly_ai_key');
          }
          if (storedGemini) {
            if (!(await electron.secrets.hasKey('gemini'))) {
              const saved = await electron.secrets.setKey('gemini', storedGemini);
              if (!saved.ok) throw new Error(saved.error || 'Could not migrate the Gemini key.');
            }
            localStorage.removeItem('gemini_api_key');
          }
        }
        applyServerSettings(await apiFetch('/api/settings'));
        await fetchCases();
      } catch (error) {
        console.error('Startup failed:', error);
      } finally {
        setAppReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!isSettingsOpen) return;
    setTempAssemblyKey('');
    setTempGeminiKey('');
    setTempPreferAssembly(preferAssemblySummary);
    setTempGatewayModel(gatewayModel);
    setTempLocalWhisper(localWhisperMode);
    setTempAllowGemini(allowGemini);
    setTempDeleteRemote(deleteRemoteTranscripts);
    setTempOfficerName(officerName);
    setTempOfficerBadge(officerBadge);
    setTempApiBase(aaiApiBase);
    setTempGatewayUrl(llmGatewayUrl);
    setTempChunkLimit(String(chunkTokenLimit));
    setTempMassConcurrency(String(massConcurrency));
  }, [isSettingsOpen]);

  useEffect(() => {
    if (selectedRecording?.speaker_labels) {
      setSpeakerLabels(selectedRecording.speaker_labels);
    } else {
      setSpeakerLabels({});
    }
    if (selectedRecording?.interview_type) {
      setInterviewType(selectedRecording.interview_type);
    }
  }, [selectedRecording]);

  const handleSaveSettings = async () => {
    const electron = getElectron();
    try {
      if (tempAssemblyKey.trim()) {
        if (!electron) throw new Error('API keys can only be saved in the desktop app.');
        const saved = await electron.secrets.setKey('assemblyai', tempAssemblyKey.trim());
        if (!saved.ok) throw new Error(saved.error || 'Could not save the AssemblyAI key.');
      }
      if (tempGeminiKey.trim()) {
        if (!electron) throw new Error('API keys can only be saved in the desktop app.');
        const saved = await electron.secrets.setKey('gemini', tempGeminiKey.trim());
        if (!saved.ok) throw new Error(saved.error || 'Could not save the Gemini key.');
      }
      setPreferAssemblySummary(tempPreferAssembly);
      setGatewayModel(tempGatewayModel);
      setLocalWhisperMode(tempLocalWhisper);
      localStorage.setItem('prefer_assembly_summary', tempPreferAssembly.toString());
      localStorage.setItem('gateway_model', tempGatewayModel);
      localStorage.setItem('local_whisper_mode', tempLocalWhisper.toString());
      if (electron) {
        localStorage.removeItem('assembly_ai_key');
        localStorage.removeItem('gemini_api_key');
      }
      const savedSettings = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          allowGemini: tempAllowGemini,
          deleteRemoteTranscripts: tempDeleteRemote,
          officerName: tempOfficerName,
          officerBadge: tempOfficerBadge,
          aaiApiBase: tempApiBase,
          llmGatewayUrl: tempGatewayUrl,
          chunkTokenLimit: Number(tempChunkLimit),
          massConcurrency: Number(tempMassConcurrency),
        }),
      });
      applyServerSettings(savedSettings);
      setTempAssemblyKey('');
      setTempGeminiKey('');
      setIsSettingsOpen(false);
    } catch (error: any) {
      alert(error.message || 'Could not save settings.');
    }
  };

  const handleClearKey = async (name: 'assemblyai' | 'gemini') => {
    const electron = getElectron();
    if (!electron) return;
    const cleared = await electron.secrets.clearKey(name);
    if (!cleared.ok) {
      alert(cleared.error || 'Could not clear that key.');
      return;
    }
    if (name === 'assemblyai') setTempAssemblyKey('');
    if (name === 'gemini') setTempGeminiKey('');
    applyServerSettings(await apiFetch('/api/settings'));
  };

  const handleCleanReports = async () => {
    if (!window.confirm('Back up the database, then remove prompt text and reasoning traces from saved reports?')) return;
    setIsCleaning(true);
    setCleanMessage(null);
    try {
      const result = await apiFetch('/api/maintenance/clean-reports', { method: 'POST' });
      setCleanMessage(`Backup: ${result.backupPath}. Cleaned ${result.recordingsChanged} of ${result.recordingsExamined} reports and ${result.timelinesChanged} of ${result.timelinesExamined} timelines.`);
      if (selectedCase) await fetchCaseDetails(selectedCase.id);
    } catch (error: any) {
      setCleanMessage(error.message || 'Clean failed.');
    } finally {
      setIsCleaning(false);
    }
  };

  const handleTestKey = async (service: 'assemblyai' | 'gemini') => {
    setIsTestingKeys(true);
    setKeyTestMessage(null);
    try {
      const result = await apiFetch('/api/keys/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service }),
      });
      setKeyTestMessage(`${result.ok ? 'Pass' : 'Fail'}: ${result.message}`);
    } catch (error: any) {
      setKeyTestMessage(`Fail: ${error.message || 'Key test failed.'}`);
    } finally {
      setIsTestingKeys(false);
    }
  };

  const handleRegress = async () => {
    setIsRegressing(true);
    setRegressMessage(null);
    try {
      const result = await apiFetch('/api/maintenance/regress', { method: 'POST' });
      const failed = (result.checks || []).filter((check: { ok: boolean }) => !check.ok);
      setRegressMessage(result.ok
        ? `Sample check passed (${result.checks.length} checks).`
        : `Sample check failed: ${failed.map((check: { name: string; detail: string }) => `${check.name}: ${check.detail}`).join(' ')}`);
    } catch (error: any) {
      setRegressMessage(error.message || 'Sample check failed.');
    } finally {
      setIsRegressing(false);
    }
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

  const safeFetch = (url: string, options?: RequestInit) => apiFetch(url, options);

  const fetchCases = async () => {
    try {
      const data = await safeFetch('/api/cases');
      setCases(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error("Failed to fetch cases:", error);
      setCases([]);
    }
  };

  const fetchCaseTimeline = async (caseId: string) => {
    try {
      const res = await safeFetch(`/api/cases/${caseId}/timeline`);
      setTimelineReport(res.timelineReport);
      setTimelineMeta(res.timelineMeta || null);
    } catch (e) {
      console.error("Failed to fetch timeline:", e);
      setTimelineReport(null);
    }
  };

  const blockedGeminiNote = () => {
    if (allowGemini && !preferAssemblySummary) return '';
    return ' Google Gemini is turned off, so this case was not sent to Google.';
  };

  const handleGenerateTimeline = async (engine: 'gateway' | 'gemini' = 'gateway') => {
    if (!selectedCase) return;
    setIsGeneratingTimeline(true);
    setTimelineError(null);
    try {
      const res = await safeFetch(`/api/cases/${selectedCase.id}/timeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: gatewayModel,
          engine,
          strictlyAssembly: preferAssemblySummary,
        })
      });
      setTimelineReport(res.timelineReport);
      setTimelineMeta(res.timelineMeta || null);
    } catch (e: any) {
      setTimelineError(`${e.message || 'Timeline generation failed.'}${engine === 'gateway' ? blockedGeminiNote() : ''}`);
    } finally {
      setIsGeneratingTimeline(false);
    }
  };

  const handleSaveTimeline = async () => {
    if (!selectedCase) return;
    try {
      await safeFetch(`/api/cases/${selectedCase.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeline_report: tempTimelineReport })
      });
      setTimelineReport(tempTimelineReport);
      setIsEditingTimeline(false);
    } catch (e: any) {
      alert(`Failed to save timeline: ${e.message}`);
    }
  };

  const fetchCaseDetails = async (id: string) => {
    try {
      setMode('cases');
      setSelectedRecording(null);
      const data = await safeFetch(`/api/cases/${id}`);
      setSelectedCase(data);
      fetchCaseTimeline(id);
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
    const file = acceptedFiles[0];
    try {
      const electron = getElectron();
      let filePath = '';
      try { filePath = electron?.pathForFile?.(file) || ''; } catch { filePath = ''; }
      let data;
      if (filePath && electron?.allowPath) {
        const allowed = await electron.allowPath(filePath);
        if (!allowed.ok) throw new Error(allowed.error || 'Could not use that file.');
        data = await apiFetch(`/api/cases/${selectedCase.id}/recordings/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath }),
        });
      } else {
        const formData = new FormData();
        formData.append('file', file);
        data = await apiFetch(`/api/cases/${selectedCase.id}/recordings`, {
          method: 'POST',
          body: formData,
        });
      }
      
      if (data.status === 'converting') {
        setIsConverting(true);
        setConversionProgress(0);
        await pollWithBackoff({
          initialDelayMs: 1000,
          maxDelayMs: 8000,
          timeoutMs: 30 * 60 * 1000,
          poll: () => apiFetch(`/api/recordings/${data.id}/convert/progress`),
          isDone: (progressData) => progressData.status === 'completed',
          onUpdate: (progressData) => setConversionProgress(Number(progressData.progress) || 0),
        });
        setIsConverting(false);
        await fetchCaseDetails(selectedCase.id);
      } else {
        await fetchCaseDetails(selectedCase.id);
      }
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
      'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.wma', '.mp2', '.amr'],
      'video/*': ['.mp4', '.mov', '.mpg', '.mpeg', '.avi', '.mkv', '.wmv', '.webm', '.3gp', '.ts', '.m2ts']
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

  // Structured request for report generation (replaces the concatenated "You are an expert
  // forensic analyst. Analyze the following transcript. ${promptToUse}" string).
  const buildReportRequest = (type: string, rec: Recording) => {
    const isBuiltIn = type in INTERVIEW_PROMPTS;
    return {
      reportType: type,
      customInstructions: isBuiltIn ? undefined : customPrompts[type],
      speakerLabels,
      caseInfo: {
        caseName: selectedCase?.name,
        recordingName: rec.original_name,
        recordingDate: rec.created_at ? format(parseSqliteDate(rec.created_at), 'yyyy-MM-dd') : undefined,
        reportType: type,
        reportingOfficer: officerName || undefined,
      },
    };
  };

  const saveReport = async (type: string, rec: Recording, engine: 'gateway' | 'gemini') => {
    const reportReq = buildReportRequest(type, rec);
    setProcessingStatus(engine === 'gemini' ? 'Writing the report with Gemini…' : 'Writing the report…');
    const result = await generateReportOnServer({
      recordingId: rec.id,
      reportType: reportReq.reportType,
      customInstructions: reportReq.customInstructions,
      speakerLabels: reportReq.speakerLabels,
      caseInfo: reportReq.caseInfo,
      model: gatewayModel,
      engine,
      aiAcknowledgedAt: aiAck?.iso,
      strictlyAssembly: preferAssemblySummary,
      onProgress: (message) => setProcessingStatus(message),
    });
    let apod = null;
    if (type === 'Child Harm Suspect Interview' && allowGemini && !preferAssemblySummary) {
      try {
        const apodRes = await apiFetch('/api/apod', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recordingId: rec.id,
            speakerLabels: reportReq.speakerLabels,
            strictlyAssembly: preferAssemblySummary,
          }),
        });
        apod = apodRes.results;
      } catch (e) {
        console.warn('APOD analysis failed.', e);
      }
    }
    const reportMeta: ReportMeta = {
      engine: result.engine,
      model: result.model,
      requestId: result.requestId,
      transcriptId: result.transcriptId,
      generatedAt: result.generatedAt,
      truncated: result.truncated,
      aiAcknowledgedAt: result.aiAcknowledgedAt || aiAck?.iso || null,
      aiAcknowledgedLabel: result.aiAcknowledgedLabel || null,
    };
    await apiFetch(`/api/recordings/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apod_results: apod,
        interview_type: type,
        report_meta: reportMeta,
      }),
    });
    if (result.transcriptId && !String(result.transcriptId).startsWith('local-whisper')) {
      try {
        await deleteRemoteTranscript(String(result.transcriptId), rec.id);
      } catch (error) {
        console.warn('Could not delete the AssemblyAI transcript:', error);
      }
    }
  };

  const handleTranscribe = async () => {
    if (!selectedRecording) return;
    if (!localWhisperMode && !hasAssemblyKey) {
      alert("Add an AssemblyAI API key in Settings.");
      return;
    }
    setIsProcessing(true);
    setReportError(null);
    setTranscriptionError(null);
    setProcessingProgress(10);
    try {
      if (localWhisperMode) {
        await transcribeLocally({
          recordingId: selectedRecording.id,
          onProgress: (message, progress) => {
            setProcessingStatus(message);
            setProcessingProgress(Math.max(10, Math.min(80, progress)));
          },
        });
      } else {
        await transcribeOnServer({
          recordingId: selectedRecording.id,
          includeBuiltinSummary: false,
          onProgress: (message, progress) => {
            setProcessingStatus(message);
            setProcessingProgress(Math.max(10, Math.min(80, progress)));
          },
        });
      }
      setProcessingProgress(88);
      const engine = (!hasAssemblyKey && allowGemini && !preferAssemblySummary) ? 'gemini' : 'gateway';
      if (engine === 'gateway' && !hasAssemblyKey) {
        throw new Error(`An AssemblyAI API key is required.${blockedGeminiNote()}`);
      }
      try {
        await saveReport(interviewType, selectedRecording, engine);
      } catch (summaryError: any) {
        console.error(summaryError);
        setReportError(`${summaryError.message || summaryError}${blockedGeminiNote()}`);
        setActiveTab('summary');
      }
      setProcessingProgress(100);
      setProcessingStatus('Complete');
      await fetchCaseDetails(selectedCase!.id);
      setSelectedRecording(await apiFetch(`/api/recordings/${selectedRecording.id}`));
    } catch (error: any) {
      const msg = error?.message || 'Transcription failed';
      console.error('Transcription failed:', error);
      if (msg.toLowerCase().includes('insufficient funds') || msg.toLowerCase().includes('balance')) {
        setTranscriptionError('AssemblyAI rejected the upload because the account balance is too low. The recording is still on this computer. Add funds at assemblyai.com, then retry.');
      } else if (msg.toLowerCase().includes('api key is disabled')) {
        setTranscriptionError('AssemblyAI says this API key is disabled. Open Settings and check the key, then retry. The recording is still on this computer.');
      } else {
        setTranscriptionError(msg);
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

  const handleExportDocx = async () => {
    if (!selectedRecording || !selectedCase) return;
    const meta = selectedRecording.report_meta;
    const reportDate = formatGeneratedAt(meta?.generatedAt) === 'Unknown'
      ? format(new Date(), 'yyyy-MM-dd HH:mm:ss')
      : formatGeneratedAt(meta?.generatedAt);
    const utteranceLines: { speaker: string; startMs: number; text: string }[] = [];
    if (selectedRecording.has_transcript) {
      let offset = 0;
      while (utteranceLines.length < 20000) {
        const page = await apiFetch(`/api/recordings/${selectedRecording.id}/utterances?offset=${offset}&limit=200&words=0`);
        const rows = page.utterances || [];
        for (const row of rows) utteranceLines.push({ speaker: row.speaker, startMs: row.start, text: row.text });
        offset += rows.length;
        if (!rows.length || offset >= (page.total || 0)) break;
      }
    }
    const blob = await reportToDocxBlob({
      caseName: selectedCase.name,
      recordingName: selectedRecording.original_name,
      reportMarkdown: selectedRecording.summary || 'No summary available.',
      officerName,
      officerBadge,
      reportDate,
      auditLine: currentAudit(meta),
      acknowledgement: meta?.aiAcknowledgedLabel,
      speakerLabels,
      utterances: utteranceLines,
    });
    saveAs(blob, `${selectedCase.name}_${selectedRecording.original_name}.docx`);
  };

  const seekTo = (time: number) => {
    if (mediaRef.current && isFinite(time)) {
      mediaRef.current.currentTime = time;
      mediaRef.current.play();
      setIsPlaying(true);
    }
  };

  const saveSpeakerLabels = async (next?: Record<string, string>) => {
    if (!selectedRecording) return;
    const labels = next || speakerLabels;
    setSpeakerLabels(labels);
    setSelectedRecording({ ...selectedRecording, speaker_labels: labels });
    try {
      await safeFetch(`/api/recordings/${selectedRecording.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speaker_labels: labels }),
      });
    } catch (error) {
      console.error("Failed to save speaker labels:", error);
    }
  };

  const triggerRegeneratePrompt = () => {
    setTempRegenType(interviewType);
    setIsRegenConfirmOpen(true);
  };

  const handleRegenerateSummary = async (typeOverride?: string, engineOverride?: 'gateway' | 'gemini') => {
    if (!selectedRecording?.has_transcript) {
      alert("No transcript available to generate summary from.");
      return;
    }
    const finalType = typeOverride || interviewType;
    const engine = engineOverride || ((!hasAssemblyKey && allowGemini && !preferAssemblySummary) ? 'gemini' : 'gateway');
    if (engine === 'gemini' && (!allowGemini || preferAssemblySummary)) {
      setReportError('Google Gemini is turned off, so this case was not sent to Google.');
      return;
    }
    if (engine === 'gateway' && !hasAssemblyKey) {
      setReportError(`An AssemblyAI API key is required.${blockedGeminiNote()}`);
      return;
    }
    setIsRegeneratingSummary(true);
    setReportError(null);
    try {
      await saveReport(finalType, selectedRecording, engine);
      setInterviewType(finalType);
      const updatedRec = await apiFetch(`/api/recordings/${selectedRecording.id}`);
      setSelectedRecording(updatedRec);
    } catch (error: any) {
      console.error("Failed to regenerate summary:", error);
      setReportError(`${error.message || error}${engine === 'gateway' ? blockedGeminiNote() : ''}`);
    } finally {
      setIsRegeneratingSummary(false);
    }
  };

  const isWordActive = (word: Word) => {
    const timeMs = currentTime * 1000;
    return timeMs >= word.start && timeMs <= word.end;
  };

  const isWordHighlighted = (wordText: string) => {
    if (!searchQuery.trim()) return false;
    return wordText.toLowerCase().includes(searchQuery.toLowerCase());
  };

  if (!appReady) {
    return (
      <div className="min-h-screen bg-[#0F1115] text-white flex items-center justify-center gap-3">
        <Loader2 className="animate-spin text-orange-500" />
        <span className="text-sm text-white/60">Opening the case library…</span>
        {!aiAck && <AiAcknowledgementModal onAcknowledge={setAiAck} />}
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#0F1115] text-white font-sans overflow-hidden">
      {!aiAck && <AiAcknowledgementModal onAcknowledge={setAiAck} />}
      {/* Sidebar */}
      <div className="w-72 border-r border-white/10 flex flex-col bg-[#16191E]">
        <div className="p-6 border-b border-white/10 flex items-center gap-3">
          <div className="w-8 h-8 bg-orange-500 rounded-lg flex items-center justify-center">
            <BarChart3 size={18} className="text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">Narrative AI</h1>
            <p className="text-[10px] uppercase tracking-widest text-white/35">Version {APP_VERSION}</p>
          </div>
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
              setMode('statistics');
              setSelectedCase(null);
              setSelectedRecording(null);
            }}
            className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all ${mode === 'statistics' ? 'bg-orange-500/10 text-orange-500' : 'hover:bg-white/5 text-white/60'}`}
          >
            <BarChart3 size={18} className={mode === 'statistics' ? 'text-orange-500' : 'text-white/40'} />
            <span className="text-sm font-medium">Statistics</span>
          </button>
          <button 
            onClick={() => {
              setInfoModalMode('mass-jail-call');
            }}
            className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all ${mode === 'mass-jail-call' ? 'bg-orange-500/10 text-orange-500' : 'hover:bg-white/5 text-white/60'}`}
          >
            <BarChart3 size={18} className={mode === 'mass-jail-call' ? 'text-orange-500' : 'text-white/40'} />
            <span className="text-sm font-medium">Mass Jail Call</span>
          </button>
          <button 
            onClick={() => {
              setInfoModalMode('mass-keyword-search');
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
                    <h4 className="text-sm font-bold uppercase tracking-widest text-orange-500">1. Setup API Keys</h4>
                    <div className="bg-black/20 rounded-2xl p-4 border border-white/5 space-y-3">
                      <p className="text-sm text-white/70 leading-relaxed">
                        Narrative.AI uses AssemblyAI for transcription and Gemini for advanced analysis.
                      </p>
                      <ul className="space-y-2">
                        <li className="flex items-start gap-2 text-xs text-white/50">
                          <div className="w-1.5 h-1.5 rounded-full bg-orange-500 mt-1 flex-shrink-0" />
                          <span><span className="text-white">AssemblyAI (Required):</span> Go to <a href="https://www.assemblyai.com" target="_blank" rel="noopener noreferrer" className="text-orange-500 hover:underline inline-flex items-center gap-1">assemblyai.com <ExternalLink size={10} /></a> to get your key for transcription.</span>
                        </li>
                        <li className="flex items-start gap-2 text-xs text-white/50">
                          <div className="w-1.5 h-1.5 rounded-full bg-orange-500 mt-1 flex-shrink-0" />
                          <span><span className="text-white">Gemini (Optional):</span> Go to <a href="https://aistudio.google.com" target="_blank" rel="noopener noreferrer" className="text-orange-500 hover:underline inline-flex items-center gap-1">AI Studio <ExternalLink size={10} /></a> to get your key for advanced forensic analysis (APOD).</span>
                        </li>
                        <li className="flex items-start gap-2 text-xs text-white/50">
                          <div className="w-1.5 h-1.5 rounded-full bg-orange-500 mt-1 flex-shrink-0" />
                          <span>Click <span className="text-white">Settings</span> in the sidebar and paste your keys.</span>
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
              className="relative w-full max-w-3xl bg-[#16191E] border border-white/10 rounded-3xl shadow-2xl overflow-hidden max-h-[92vh] overflow-y-auto"
            >
              <div className="p-8">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 bg-orange-500/10 rounded-xl flex items-center justify-center">
                    <Settings size={20} className="text-orange-500" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold">Settings</h3>
                    <p className="text-xs text-white/40">Narrative AI {APP_VERSION}. Configure application keys and custom prompts.</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  {/* Left Column: API Keys */}
                  <div className="space-y-6">
                    <div className="rounded-xl border border-white/10 bg-black/30 p-4 text-[11px] leading-relaxed text-white/60 space-y-2">
                      <p className="text-xs font-bold uppercase tracking-widest text-white/80">Where case data goes</p>
                      <p>Audio is uploaded from this computer to AssemblyAI in the US for transcription. Reports are written by the AssemblyAI LLM Gateway in the US (Claude Sonnet 4.6 by default, gpt-oss-120b if that call fails). The transcript text is sent with the report request. AssemblyAI says gateway providers are opted out of model training. A transcript that is not deleted stays on AssemblyAI until their retention window ends.</p>
                      <p>After a transcript and report are saved on this computer, Narrative AI deletes the transcript from AssemblyAI. That is on unless you turn it off below.</p>
                      <p>Case audio, jail calls, timelines, and APOD are not sent to Google unless you turn on Allow Google Gemini. Gemini is not CJIS-approved. Leave it off for criminal justice data.</p>
                      <p>API keys are encrypted with the operating system credential store and stay in the desktop app. They are not kept in this window. The local server listens only on 127.0.0.1.</p>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-white/40 px-1">AssemblyAI API Key (Required)</label>
                      <input 
                        type="password"
                        value={tempAssemblyKey}
                        onChange={e => setTempAssemblyKey(e.target.value)}
                        placeholder={hasAssemblyKey ? 'Key saved on this computer — enter a new key to replace it' : 'Enter your API key'}
                        autoComplete="off"
                        className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-sm focus:border-orange-500 transition-colors outline-none"
                      />
                      <div className="flex items-center justify-between px-1">
                        <p className="text-[10px] text-white/30">
                          {hasAssemblyKey ? 'A key is saved.' : 'No key saved.'} Get one at <a href="https://www.assemblyai.com" target="_blank" rel="noopener noreferrer" className="text-orange-500 hover:underline">assemblyai.com</a>
                        </p>
                        {hasAssemblyKey && (
                          <button type="button" onClick={() => handleClearKey('assemblyai')} className="text-[10px] font-bold uppercase text-red-400">Clear</button>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-white/40 px-1">Gemini API Key (Optional)</label>
                      <input 
                        type="password"
                        value={tempGeminiKey}
                        onChange={e => setTempGeminiKey(e.target.value)}
                        placeholder={hasGeminiKey ? 'Key saved on this computer — enter a new key to replace it' : 'Enter your Gemini API key'}
                        autoComplete="off"
                        className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-sm focus:border-orange-500 transition-colors outline-none"
                      />
                      <div className="flex items-center justify-between px-1">
                        <p className="text-[10px] text-white/30">{hasGeminiKey ? 'A key is saved.' : 'No key saved.'}</p>
                        {hasGeminiKey && (
                          <button type="button" onClick={() => handleClearKey('gemini')} className="text-[10px] font-bold uppercase text-red-400">Clear</button>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-between p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl">
                      <div>
                        <p className="text-sm font-bold">Allow Google Gemini (not CJIS-approved)</p>
                        <p className="text-[10px] text-white/50">Off by default. Turns on Gemini for reports, mass jail calls, the case timeline, and APOD. Leave this off for criminal justice data.</p>
                      </div>
                      <button 
                        onClick={() => setTempAllowGemini(!tempAllowGemini)}
                        className={`w-12 h-6 rounded-full transition-all relative shrink-0 ${tempAllowGemini ? 'bg-amber-500' : 'bg-white/10'}`}
                      >
                        <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${tempAllowGemini ? 'left-7' : 'left-1'}`} />
                      </button>
                    </div>

                    <div className="flex items-center justify-between p-4 bg-black/20 border border-white/10 rounded-xl">
                      <div>
                        <p className="text-sm font-bold">Delete AssemblyAI transcripts after save</p>
                        <p className="text-[10px] text-white/40">On by default. Deletes the transcript from AssemblyAI after it and the report are stored on this computer. Success and failure are written to the log and the database.</p>
                      </div>
                      <button 
                        onClick={() => setTempDeleteRemote(!tempDeleteRemote)}
                        className={`w-12 h-6 rounded-full transition-all relative shrink-0 ${tempDeleteRemote ? 'bg-orange-500' : 'bg-white/10'}`}
                      >
                        <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${tempDeleteRemote ? 'left-7' : 'left-1'}`} />
                      </button>
                    </div>

                    <div className="flex items-center justify-between p-4 bg-black/20 border border-white/10 rounded-xl">
                      <div>
                        <p className="text-sm font-bold">Strictly Use AssemblyAI Summaries</p>
                        <p className="text-[10px] text-white/40">Disable Gemini fallback to avoid safety filter refusals on sensitive material.</p>
                      </div>
                      <button 
                        onClick={() => setTempPreferAssembly(!tempPreferAssembly)}
                        className={`w-12 h-6 rounded-full transition-all relative ${tempPreferAssembly ? 'bg-orange-500' : 'bg-white/10'}`}
                      >
                        <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${tempPreferAssembly ? 'left-7' : 'left-1'}`} />
                      </button>
                    </div>

                    <div className="flex items-center justify-between p-4 bg-black/20 border border-white/10 rounded-xl">
                      <div>
                        <p className="text-sm font-bold">Local Offline Transcription (Whisper)</p>
                        <p className="text-[10px] text-white/40">Transcribe on this computer. Reports still use the AssemblyAI gateway unless you enable Gemini.</p>
                      </div>
                      <button 
                        onClick={() => setTempLocalWhisper(!tempLocalWhisper)}
                        className={`w-12 h-6 rounded-full transition-all relative ${tempLocalWhisper ? 'bg-orange-500' : 'bg-white/10'}`}
                      >
                        <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${tempLocalWhisper ? 'left-7' : 'left-1'}`} />
                      </button>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-white/40 px-1">Default Gateway Model</label>
                      <select
                        value={tempGatewayModel}
                        onChange={e => setTempGatewayModel(e.target.value)}
                        className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:border-orange-500 transition-colors outline-none cursor-pointer"
                      >
                        <option value="claude-sonnet-4-6">claude-sonnet-4-6 (Recommended for formal reports)</option>
                        <option value="gpt-oss-120b">gpt-oss-120b (Fewest refusals; reasoning text is stripped automatically)</option>
                      </select>
                      <p className="text-[10px] text-white/30 px-1">
                        The other model is used automatically if the selected model returns an error.
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-white/40 px-1">Officer name</label>
                        <input value={tempOfficerName} onChange={e => setTempOfficerName(e.target.value)} className="w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-500" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-white/40 px-1">Badge</label>
                        <input value={tempOfficerBadge} onChange={e => setTempOfficerBadge(e.target.value)} className="w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-500" />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-white/40 px-1">AssemblyAI API base (US default)</label>
                      <input value={tempApiBase} onChange={e => setTempApiBase(e.target.value)} className="w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2 text-xs outline-none focus:border-orange-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-white/40 px-1">LLM Gateway URL (US default)</label>
                      <input value={tempGatewayUrl} onChange={e => setTempGatewayUrl(e.target.value)} className="w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2 text-xs outline-none focus:border-orange-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-white/40 px-1">Split transcripts over this many tokens</label>
                      <input value={tempChunkLimit} onChange={e => setTempChunkLimit(e.target.value)} className="w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-white/40 px-1">Mass processing at once</label>
                      <input value={tempMassConcurrency} onChange={e => setTempMassConcurrency(e.target.value)} className="w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-500" />
                      <p className="text-[10px] text-white/30 px-1">How many jail calls or keyword files run together. 1 to 4. Default 2.</p>
                    </div>
                    <div className="space-y-2 rounded-xl border border-white/10 p-4">
                      <p className="text-sm font-bold">Test my keys</p>
                      <p className="text-[10px] text-white/40">Checks the saved key with a short authenticated call. The key is not shown or written to the log. Gemini is tested only when it is enabled.</p>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" disabled={isTestingKeys} onClick={() => handleTestKey('assemblyai')} className="px-3 py-2 rounded-lg bg-white/10 text-xs font-bold disabled:opacity-50">Test AssemblyAI</button>
                        <button type="button" disabled={isTestingKeys || !tempAllowGemini} onClick={() => handleTestKey('gemini')} className="px-3 py-2 rounded-lg bg-white/10 text-xs font-bold disabled:opacity-50">Test Gemini</button>
                      </div>
                      {keyTestMessage && <p className="text-[11px] text-white/70">{keyTestMessage}</p>}
                    </div>
                    <div className="space-y-2 rounded-xl border border-white/10 p-4">
                      <p className="text-sm font-bold">Advanced: sample check</p>
                      <p className="text-[10px] text-white/40">Runs synthetic recordings through the report pipeline with mocked model output. It does not call AssemblyAI.</p>
                      <button type="button" disabled={isRegressing} onClick={handleRegress} className="px-3 py-2 rounded-lg bg-white/10 text-xs font-bold disabled:opacity-50">
                        {isRegressing ? 'Running…' : 'Run sample check'}
                      </button>
                      {regressMessage && <p className="text-[11px] text-white/70">{regressMessage}</p>}
                    </div>
                    <div className="space-y-2 rounded-xl border border-white/10 p-4">
                      <p className="text-sm font-bold">Clean existing reports</p>
                      <p className="text-[10px] text-white/40">Backs up the database, then runs the report cleaner over saved summaries and case timelines.</p>
                      <button type="button" onClick={handleCleanReports} disabled={isCleaning} className="px-3 py-2 rounded-lg bg-white/10 text-xs font-bold disabled:opacity-50">
                        {isCleaning ? 'Cleaning…' : 'Clean existing reports'}
                      </button>
                      {cleanMessage && <p className="text-[11px] text-white/70 break-all">{cleanMessage}</p>}
                    </div>
                  </div>

                  {/* Right Column: Custom Prompts */}
                  <div className="flex flex-col border-l border-white/10 pl-0 md:pl-8 space-y-4">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-white/40 px-1">Custom Investigative Prompts</label>
                    
                    {/* List of custom prompts */}
                    <div className="flex-1 max-h-48 overflow-y-auto space-y-2 pr-2">
                      {Object.keys(customPrompts).length === 0 ? (
                        <p className="text-xs text-white/30 italic p-3 text-center bg-black/10 rounded-xl">No custom prompts created yet.</p>
                      ) : (
                        Object.entries(customPrompts).map(([name, text]) => (
                          <div key={name} className="flex items-start justify-between gap-3 p-3 bg-black/20 border border-white/5 rounded-xl text-xs">
                            <div className="min-w-0 flex-1">
                              <p className="font-bold text-orange-500 truncate">{name}</p>
                              <p className="text-[10px] text-white/50 line-clamp-2 mt-0.5" title={text}>{text}</p>
                            </div>
                            <button 
                              onClick={() => handleDeletePrompt(name)}
                              className="text-red-500 hover:text-red-400 p-1 rounded hover:bg-white/5 transition-colors shrink-0"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))
                      )}
                    </div>

                    {/* Add form */}
                    <div className="space-y-3 pt-3 border-t border-white/10">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-white/40">Add Custom Template</p>
                      <input 
                        type="text"
                        placeholder="Prompt Title (e.g. Field Report)"
                        value={newPromptName}
                        onChange={e => setNewPromptName(e.target.value)}
                        className="w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2 text-xs focus:border-orange-500 outline-none placeholder:text-white/20 text-white"
                      />
                      <textarea 
                        placeholder="Describe template focus: 'Analyze field stop details, suspect identity claims, and officer orders...'"
                        value={newPromptText}
                        onChange={e => setNewPromptText(e.target.value)}
                        rows={3}
                        className="w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2 text-xs focus:border-orange-500 outline-none resize-none placeholder:text-white/20 text-white"
                      />
                      <button 
                        onClick={handleAddPrompt}
                        className="w-full py-2 bg-orange-500 hover:bg-orange-600 rounded-xl text-xs font-bold transition-all"
                      >
                        Add Custom Prompt
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex gap-3 mt-8 justify-end">
                  <button 
                    onClick={() => setIsSettingsOpen(false)}
                    className="px-6 py-2.5 rounded-xl font-bold text-sm bg-white/5 hover:bg-white/10 transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleSaveSettings}
                    className="px-6 py-2.5 rounded-xl font-bold text-sm bg-orange-500 hover:bg-orange-600 transition-all shadow-lg shadow-orange-500/20"
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

      {/* Regenerate Confirmation Modal */}
      <AnimatePresence>
        {isRegenConfirmOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsRegenConfirmOpen(false)}
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
                    <FileText size={20} className="text-orange-500" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold">Regenerate Summary</h3>
                    <p className="text-xs text-white/40">Select the analysis template</p>
                  </div>
                </div>

                <div className="space-y-4 mb-8">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-white/40 px-1">Analysis Profile Template</label>
                    <select
                      value={tempRegenType}
                      onChange={e => setTempRegenType(e.target.value)}
                      className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:border-orange-500 transition-colors outline-none cursor-pointer"
                    >
                      {Object.keys(INTERVIEW_PROMPTS).map(p => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                      {Object.keys(customPrompts).map(p => (
                        <option key={p} value={p}>{p} (Custom)</option>
                      ))}
                    </select>
                  </div>
                  <p className="text-xs text-white/40 leading-relaxed px-1">
                    This will regenerate the chronological narrative report. Existing summary data for this recording will be replaced.
                  </p>
                </div>

                <div className="flex gap-3">
                  <button 
                    onClick={() => setIsRegenConfirmOpen(false)}
                    className="flex-1 px-4 py-3 rounded-xl font-bold text-sm bg-white/5 hover:bg-white/10 transition-all text-white"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={async () => {
                      setIsRegenConfirmOpen(false);
                      setInterviewType(tempRegenType);
                      await handleRegenerateSummary(tempRegenType);
                    }}
                    className="flex-1 px-4 py-3 rounded-xl font-bold text-sm bg-orange-500 hover:bg-orange-600 transition-all text-white shadow-lg shadow-orange-500/20"
                  >
                    Regenerate
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Mass Tools Instruction Modal */}
      <AnimatePresence>
        {infoModalMode && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setInfoModalMode(null)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-lg bg-[#16191E] border border-white/10 rounded-3xl shadow-2xl overflow-hidden text-white"
            >
              <div className="p-8">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 bg-orange-500/10 rounded-xl flex items-center justify-center">
                    {infoModalMode === 'mass-jail-call' ? (
                      <BarChart3 size={20} className="text-orange-500" />
                    ) : (
                      <Search size={20} className="text-orange-500" />
                    )}
                  </div>
                  <div>
                    <h3 className="text-xl font-bold">
                      {infoModalMode === 'mass-jail-call' ? 'Mass Jail Call Processing' : 'Mass Keyword Search'}
                    </h3>
                    <p className="text-xs text-white/40">Instructions & Options Guide</p>
                  </div>
                </div>

                <div className="space-y-6 text-sm text-white/70 mb-8 leading-relaxed">
                  {infoModalMode === 'mass-jail-call' ? (
                    <>
                      <p>
                        The <strong className="text-white">Mass Jail Call Processing</strong> module is designed to analyze multiple inmate recordings simultaneously, automating review of volume call files.
                      </p>
                      <div className="space-y-3 bg-white/5 p-5 rounded-2xl border border-white/5">
                        <h4 className="text-[10px] font-bold uppercase tracking-widest text-orange-500 mb-2">Options to Apply:</h4>
                        
                        <label className="flex items-start gap-3 cursor-pointer group">
                          <input 
                            type="checkbox" 
                            checked={jailCallQueue} 
                            onChange={e => setJailCallQueue(e.target.checked)}
                            className="mt-1 rounded bg-[#16191E] border border-white/10 text-orange-500 focus:ring-0 focus:ring-offset-0 focus:outline-none w-4 h-4 cursor-pointer"
                          />
                          <div className="text-xs">
                            <span className="font-bold text-white group-hover:text-orange-500 transition-colors">Bulk Upload & Queue</span>
                            <p className="text-white/40 mt-0.5">Drop multiple audio/video files (MP3, WAV, MP4, etc.) to queue them for processing.</p>
                          </div>
                        </label>

                        <label className="flex items-start gap-3 cursor-pointer group pt-2 border-t border-white/5">
                          <input 
                            type="checkbox" 
                            checked={jailCallTranscribe} 
                            onChange={e => setJailCallTranscribe(e.target.checked)}
                            className="mt-1 rounded bg-[#16191E] border border-white/10 text-orange-500 focus:ring-0 focus:ring-offset-0 focus:outline-none w-4 h-4 cursor-pointer"
                          />
                          <div className="text-xs">
                            <span className="font-bold text-white group-hover:text-orange-500 transition-colors">Universal Transcription</span>
                            <p className="text-white/40 mt-0.5">Transcribe each call in parallel using AssemblyAI's latest universal-3-5-pro and universal-2 accuracy models.</p>
                          </div>
                        </label>

                        <label className="flex items-start gap-3 cursor-pointer group pt-2 border-t border-white/5">
                          <input 
                            type="checkbox" 
                            checked={jailCallSummarize} 
                            onChange={e => setJailCallSummarize(e.target.checked)}
                            className="mt-1 rounded bg-[#16191E] border border-white/10 text-orange-500 focus:ring-0 focus:ring-offset-0 focus:outline-none w-4 h-4 cursor-pointer"
                          />
                          <div className="text-xs">
                            <span className="font-bold text-white group-hover:text-orange-500 transition-colors">Intelligence Summary</span>
                            <p className="text-white/40 mt-0.5">Automatically extract significant statements, admissions, mentioned entities (people, places, numbers), and case leads.</p>
                          </div>
                        </label>
                      </div>
                      <div className="space-y-2 bg-orange-500/5 p-4 rounded-2xl border border-orange-500/10 text-xs">
                        <h4 className="font-bold text-orange-500">Prerequisites:</h4>
                        <p>Requires an active <strong className="text-white">AssemblyAI API Key</strong> in Settings.</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <p>
                        The <strong className="text-white">Mass Keyword Search</strong> module transcribes and automatically scans multiple recordings to search for specific words, codes, names, or drug terminologies.
                      </p>
                      <div className="space-y-3 bg-white/5 p-5 rounded-2xl border border-white/5">
                        <h4 className="text-[10px] font-bold uppercase tracking-widest text-orange-500 mb-2">Options to Apply:</h4>
                        
                        <label className="flex items-start gap-3 cursor-pointer group">
                          <input 
                            type="checkbox" 
                            checked={keywordBoost} 
                            onChange={e => setKeywordBoost(e.target.checked)}
                            className="mt-1 rounded bg-[#16191E] border border-white/10 text-orange-500 focus:ring-0 focus:ring-offset-0 focus:outline-none w-4 h-4 cursor-pointer"
                          />
                          <div className="text-xs">
                            <span className="font-bold text-white group-hover:text-orange-500 transition-colors">Keyword Boosting</span>
                            <p className="text-white/40 mt-0.5">Provide a comma-separated list of target keywords. The transcription engine increases speech recognition sensitivity for these specific terms.</p>
                          </div>
                        </label>

                        <label className="flex items-start gap-3 cursor-pointer group pt-2 border-t border-white/5">
                          <input 
                            type="checkbox" 
                            checked={keywordTranscribe} 
                            onChange={e => setKeywordTranscribe(e.target.checked)}
                            className="mt-1 rounded bg-[#16191E] border border-white/10 text-orange-500 focus:ring-0 focus:ring-offset-0 focus:outline-none w-4 h-4 cursor-pointer"
                          />
                          <div className="text-xs">
                            <span className="font-bold text-white group-hover:text-orange-500 transition-colors">Parallel Transcription</span>
                            <p className="text-white/40 mt-0.5">Audio files are transcribed using AssemblyAI's Universal model suite.</p>
                          </div>
                        </label>

                        <label className="flex items-start gap-3 cursor-pointer group pt-2 border-t border-white/5">
                          <input 
                            type="checkbox" 
                            checked={keywordContext} 
                            onChange={e => setKeywordContext(e.target.checked)}
                            className="mt-1 rounded bg-[#16191E] border border-white/10 text-orange-500 focus:ring-0 focus:ring-offset-0 focus:outline-none w-4 h-4 cursor-pointer"
                          />
                          <div className="text-xs">
                            <span className="font-bold text-white group-hover:text-orange-500 transition-colors">Contextual Matches</span>
                            <p className="text-white/40 mt-0.5">The system automatically extracts exact timestamps and snippets showing the context of when each keyword was spoken.</p>
                          </div>
                        </label>
                      </div>
                      <div className="space-y-2 bg-orange-500/5 p-4 rounded-2xl border border-orange-500/10 text-xs">
                        <h4 className="font-bold text-orange-500">Prerequisites:</h4>
                        <p>Requires entering one or more comma-separated target keywords before processing, and a valid <strong className="text-white">AssemblyAI API Key</strong> in Settings.</p>
                      </div>
                    </>
                  )}
                </div>

                <div className="flex gap-3">
                  <button 
                    onClick={() => setInfoModalMode(null)}
                    className="flex-1 px-4 py-3 rounded-xl font-bold text-sm bg-white/5 hover:bg-white/10 transition-all text-white border border-white/5"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={() => {
                      const targetMode = infoModalMode;
                      setInfoModalMode(null);
                      setMode(targetMode);
                      setSelectedCase(null);
                      setSelectedRecording(null);
                    }}
                    className="flex-1 px-4 py-3 rounded-xl font-bold text-sm bg-orange-500 hover:bg-orange-600 transition-all text-white shadow-lg shadow-orange-500/20"
                  >
                    Proceed to Module
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {mode === 'statistics' ? (
          <div className="flex-1 flex flex-col p-8 overflow-y-auto">
            <div className="max-w-5xl mx-auto w-full space-y-8">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 bg-orange-500/10 rounded-xl flex items-center justify-center">
                  <BarChart3 size={20} className="text-orange-500" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold tracking-tight">Usage Statistics</h2>
                  <p className="text-sm text-white/40">Real-time insights into your case management and transcription activity</p>
                </div>
              </div>
              <StatsView />
            </div>
          </div>
        ) : mode !== 'cases' ? (
          <MassProcessingView 
            mode={mode as any} 
            preferAssemblySummary={preferAssemblySummary}
            allowGemini={allowGemini}
            gatewayModel={gatewayModel}
            hasAssemblyKey={hasAssemblyKey}
            hasGeminiKey={hasGeminiKey}
            massConcurrency={massConcurrency}
            jailCallQueue={jailCallQueue}
            jailCallTranscribe={jailCallTranscribe}
            jailCallSummarize={jailCallSummarize}
            keywordBoost={keywordBoost}
            keywordTranscribe={keywordTranscribe}
            keywordContext={keywordContext}
            aiAcknowledgedAt={aiAck?.iso}
          />
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
                  className="bg-[#16191E] border border-white/10 rounded-lg text-xs px-3 py-2 outline-none focus:border-orange-500 transition-colors max-w-[200px] truncate"
                  value={interviewType}
                  onChange={e => setInterviewType(e.target.value)}
                >
                  {Object.keys(INTERVIEW_PROMPTS).map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                  {Object.keys(customPrompts).map(p => (
                    <option key={p} value={p}>{p} (Custom)</option>
                  ))}
                </select>
                <div {...getRootProps()} className={`px-4 py-2 rounded-lg border border-dashed border-white/20 hover:border-orange-500/50 hover:bg-orange-500/5 transition-all cursor-pointer flex items-center gap-2 text-sm ${isUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                  <input {...getInputProps()} />
                  {isUploading ? <Loader2 className="animate-spin" size={16} /> : <Upload size={16} />}
                  <span>{isUploading ? 'Uploading...' : 'Add Recording'}</span>
                </div>
              </div>
            </div>

            <div className="flex-1 flex overflow-hidden min-h-0">
              {/* Recordings List */}
              <div className="w-64 border-r border-white/10 overflow-y-auto p-4 space-y-3">
                <button
                  onClick={() => {
                    setSelectedRecording(null);
                    fetchCaseTimeline(selectedCase.id);
                  }}
                  className={`w-full text-left p-3 rounded-xl transition-all border flex items-center gap-2 ${!selectedRecording ? 'bg-orange-500/10 border-orange-500/30 text-orange-500 font-bold' : 'border-transparent hover:bg-white/5 opacity-70'}`}
                >
                  <Calendar size={14} className={!selectedRecording ? "text-orange-500" : "text-white/40"} />
                  <span className="text-xs uppercase tracking-wider">Case Timeline</span>
                </button>
                <div className="border-t border-white/5 my-2" />
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
              <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#0F1115]">
                {selectedRecording ? (
                  <>
                    {/* Media Player */}
                    <div 
                      className="bg-black/20 border-b border-white/10 overflow-hidden flex flex-col"
                      style={{ height: `${topHeight}px` }}
                    >
                      <div className="flex-1 p-4 md:p-6 flex items-center justify-center min-h-0">
                        <div className="w-full h-full flex items-center justify-center">
                          <div className="relative w-full h-full max-w-full max-h-full bg-black rounded-2xl overflow-hidden group border border-white/5 shadow-2xl flex items-center justify-center">
                            {selectedRecording.mime_type.startsWith('video') && !useAudioFallback ? (
                              <video 
                                key={selectedRecording.id}
                                ref={mediaRef as any}
                                src={`/uploads/${selectedRecording.filename}`}
                                className="max-w-full max-h-full w-auto h-auto object-contain"
                                onTimeUpdate={handleTimeUpdate}
                                onPlay={() => setIsPlaying(true)}
                                onPause={() => setIsPlaying(false)}
                                onError={handleMediaError}
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-orange-500/10 to-blue-500/10 relative">
                                {mediaError && !useAudioFallback && (
                                  <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-10 p-6 text-center">
                                    <div className="space-y-2">
                                      <AlertCircle className="mx-auto text-red-500" size={32} />
                                      <p className="text-sm font-medium text-white">{mediaError}</p>
                                      <p className="text-xs text-white/40">The file format might not be supported by your browser.</p>
                                    </div>
                                  </div>
                                )}
                                <div className="flex flex-col items-center gap-4">
                                  <FileAudio size={64} className="text-orange-500/40 animate-pulse" />
                                  {useAudioFallback && (
                                    <span className="text-[10px] font-bold uppercase tracking-widest text-orange-500/60">Playing Audio Version</span>
                                  )}
                                </div>
                                <audio 
                                  key={`${selectedRecording.id}-${useAudioFallback}`}
                                  ref={mediaRef as any}
                                  src={`/uploads/${(useAudioFallback || selectedRecording.transcription_filename !== selectedRecording.filename) ? selectedRecording.transcription_filename : selectedRecording.filename}`}
                                  onTimeUpdate={handleTimeUpdate}
                                  onPlay={() => setIsPlaying(true)}
                                  onPause={() => setIsPlaying(false)}
                                  onError={handleMediaError}
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
                                    if (mediaRef.current && isFinite(mediaRef.current.duration)) {
                                      mediaRef.current.currentTime = pct * mediaRef.current.duration;
                                    }
                                  }}>
                                    <div 
                                      className="h-full bg-orange-500" 
                                      style={{ 
                                        width: `${mediaRef.current && isFinite(mediaRef.current.duration) && mediaRef.current.duration > 0 
                                          ? (currentTime / mediaRef.current.duration) * 100 
                                          : 0}%` 
                                      }}
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
                      <div className="flex items-center gap-2">
                        {selectedRecording.has_transcript && (
                          <button 
                            onClick={triggerRegeneratePrompt}
                            disabled={isRegeneratingSummary}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-orange-500 text-white hover:bg-orange-600 transition-all text-[10px] font-bold uppercase tracking-wider disabled:opacity-50"
                            title="Generate or regenerate full Officer Narrative summary"
                          >
                            {isRegeneratingSummary ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                            <span>{isRegeneratingSummary ? 'Generating...' : 'Regenerate Narrative'}</span>
                          </button>
                        )}
                        {selectedRecording.summary && selectedRecording.has_transcript && (
                          <button 
                            onClick={handleExportDocx}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-orange-500/10 text-orange-500 hover:bg-orange-500/20 transition-all text-[10px] font-bold uppercase tracking-wider"
                          >
                            <Download size={14} />
                            Export DOCX
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Tab Content */}
                    <div className="flex-1 min-h-0 overflow-y-auto p-6">
                      <AnimatePresence mode="wait">
                        {activeTab === 'transcript' && (
                          <motion.div 
                            key="transcript"
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -10 }}
                            className="max-w-3xl mx-auto space-y-8"
                          >
                            {!selectedRecording.has_transcript ? (
                              <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-white/5 rounded-3xl">
                                <FileText size={48} className="text-white/10 mb-4" />
                                <p className="text-white/40 mb-6">No transcript available for this recording</p>
                                
                                {transcriptionError && !isProcessing && (
                                  <div className="w-full max-w-md mx-auto mb-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100 space-y-3 text-left">
                                    <div className="flex items-start gap-2">
                                      <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
                                      <p>{transcriptionError}</p>
                                    </div>
                                    <button
                                      onClick={handleTranscribe}
                                      className="px-3 py-1.5 rounded-lg bg-white text-black text-xs font-bold inline-flex items-center gap-1"
                                    >
                                      <RotateCcw size={12} /> Retry upload
                                    </button>
                                  </div>
                                )}
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
                                ) : !transcriptionError && (
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
                              <SpeakerNamePanel
                                recordingId={selectedRecording.id}
                                speakerLabels={speakerLabels}
                                onLabels={setSpeakerLabels}
                                onSave={saveSpeakerLabels}
                              />
                              <TranscriptList
                                recordingId={selectedRecording.id}
                                speakerLabels={speakerLabels}
                                onSpeakerLabel={(speaker, name) => setSpeakerLabels({ ...speakerLabels, [speaker]: name })}
                                onSaveLabels={() => saveSpeakerLabels()}
                                currentTimeMs={currentTime * 1000}
                                onSeek={seekTo}
                              />
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
                            className="max-w-5xl mx-auto space-y-6"
                          >
                            {selectedRecording.summary ? (
                              <div className="space-y-6">
                                <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-orange-500/10 border border-orange-500/20 rounded-2xl">
                                  <div className="flex items-center gap-3">
                                    <FileText className="text-orange-500 shrink-0" size={22} />
                                    <div>
                                      <p className="text-xs font-bold uppercase tracking-wider text-orange-500">Officer Narrative & Case Analysis Report</p>
                                      <p className="text-[10px] text-white/50">Full chronological narrative generated for law enforcement documentation</p>
                                    </div>
                                  </div>
                                  <div className="flex items-center flex-wrap gap-2">
                                    <button
                                      onClick={handleCopyFinalSummary}
                                      data-testid="copy-final-summary"
                                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-orange-500 text-white text-xs font-bold transition-all"
                                      title="Copy the Final Summary as plain text"
                                    >
                                      {finalCopySuccess ? <Check size={14} /> : <Copy size={14} />}
                                      <span>{finalCopySuccess ? 'Copied!' : 'Copy Final Summary'}</span>
                                    </button>
                                    <button 
                                      onClick={handleCopySummary}
                                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-all border border-white/10"
                                      title="Copy complete narrative text to clipboard for RMS or reports"
                                    >
                                      {copySuccess ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                                      <span>{copySuccess ? 'Copied!' : 'Copy Text'}</span>
                                    </button>
                                    <button 
                                      onClick={handlePrintReport}
                                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-all border border-white/10"
                                      title="Print the report"
                                    >
                                      <Printer size={14} />
                                      <span>Print</span>
                                    </button>
                                    <button 
                                      onClick={handleExportPdf}
                                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-all border border-white/10"
                                      title="Save a PDF from the desktop app"
                                    >
                                      <Download size={14} />
                                      <span>Export PDF</span>
                                    </button>
                                    <button 
                                      onClick={() => setIsSummaryExpanded(true)}
                                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-all border border-white/10"
                                      title="Open full-screen reader"
                                    >
                                      <Maximize2 size={14} />
                                      <span>Fullscreen View</span>
                                    </button>
                                    <button 
                                      onClick={triggerRegeneratePrompt}
                                      disabled={isRegeneratingSummary}
                                      className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-orange-500 text-white text-xs font-bold hover:bg-orange-600 transition-all disabled:opacity-50 shadow-md shadow-orange-500/20"
                                    >
                                      {isRegeneratingSummary ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                                      <span>{isRegeneratingSummary ? 'Generating...' : 'Regenerate Narrative'}</span>
                                    </button>
                                  </div>
                                </div>

                                {/* Summary Search Filter */}
                                <div className="relative">
                                  <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/40" size={16} />
                                  <input 
                                    type="text"
                                    placeholder="Filter or search terms inside Officer Narrative report..."
                                    value={summaryFilter}
                                    onChange={(e) => setSummaryFilter(e.target.value)}
                                    className="w-full pl-10 pr-4 py-2 bg-white/5 border border-white/10 rounded-xl text-xs text-white placeholder:text-white/40 focus:outline-none focus:border-orange-500/50"
                                  />
                                  {summaryFilter && (
                                    <button 
                                      onClick={() => setSummaryFilter('')}
                                      className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-white/40 hover:text-white"
                                    >
                                      Clear
                                    </button>
                                  )}
                                </div>

                                {selectedRecording.summary && !extractFinalSummary(selectedRecording.summary) && (
                                  <p className="text-xs text-white/40">This report has no Final Summary section. Regenerate the narrative to add a paste-ready overview.</p>
                                )}
                                {selectedRecording.summary && extractFinalSummary(selectedRecording.summary) && (
                                  <div data-testid="final-summary" className="rounded-2xl border border-orange-500/30 bg-orange-500/5 p-5 space-y-3">
                                    <p className="text-xs font-bold uppercase tracking-wider text-orange-500">Final Summary</p>
                                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/85">{markdownToPlain(extractFinalSummary(selectedRecording.summary) || '')}</p>
                                    <p className="text-[11px] text-white/40">{AI_DISCLAIMER}</p>
                                    {selectedRecording.report_meta?.aiAcknowledgedLabel && (
                                      <p className="text-[11px] text-white/40">{selectedRecording.report_meta.aiAcknowledgedLabel}</p>
                                    )}
                                  </div>
                                )}
                                {reportError && (
                                  <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200 space-y-3">
                                    <p>{reportError}</p>
                                    <div className="flex flex-wrap gap-2">
                                      <button onClick={() => handleRegenerateSummary()} className="px-3 py-1.5 rounded-lg bg-white text-black text-xs font-bold">Retry</button>
                                      {allowGemini && !preferAssemblySummary && (
                                        <button onClick={() => handleRegenerateSummary(undefined, 'gemini')} className="px-3 py-1.5 rounded-lg bg-white/10 text-xs font-bold">Send to Gemini instead</button>
                                      )}
                                    </div>
                                  </div>
                                )}
                                <ReportBody
                                  markdown={selectedRecording.summary}
                                  filter={summaryFilter}
                                  meta={selectedRecording.report_meta}
                                  truncated={selectedRecording.report_meta?.truncated}
                                  continuing={isRegeneratingSummary}
                                  onContinue={() => handleRegenerateSummary()}
                                />
                                {selectedRecording.aai_deleted_at && (
                                  <p className="text-[10px] text-white/40">AssemblyAI transcript deleted {selectedRecording.aai_deleted_at}.</p>
                                )}
                              </div>
                            ) : (
                              <div className="text-center py-20 border-2 border-dashed border-white/5 rounded-3xl p-8 space-y-4">
                                <FileText size={48} className="mx-auto text-white/20" />
                                <p className="text-sm text-white/60">No summary generated for this recording yet</p>
                                {reportError && <p className="text-xs text-red-300 max-w-md mx-auto">{reportError}</p>}
                                {selectedRecording.has_transcript ? (
                                  <button 
                                    onClick={triggerRegeneratePrompt}
                                    disabled={isRegeneratingSummary}
                                    className="px-6 py-2.5 bg-orange-500 hover:bg-orange-600 rounded-xl font-bold text-xs transition-all flex items-center gap-2 mx-auto disabled:opacity-50"
                                  >
                                    {isRegeneratingSummary ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
                                    Generate Officer Narrative Summary
                                  </button>
                                ) : (
                                  <p className="text-xs text-white/40">Transcribe the recording first to generate a summary.</p>
                                )}
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
                  <div className="flex-1 flex flex-col min-h-0 bg-[#0F1115] overflow-y-auto p-6 md:p-10">
                    <div className="max-w-4xl mx-auto w-full space-y-6">
                      <div className="flex items-center justify-between border-b border-white/10 pb-6">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 bg-orange-500/10 rounded-2xl flex items-center justify-center">
                            <Calendar size={24} className="text-orange-500" />
                          </div>
                          <div>
                            <h2 className="text-2xl font-bold tracking-tight">Case Timeline & Log</h2>
                            <p className="text-sm text-white/40">Chronological timeline compiled from all recording transcripts in this case</p>
                          </div>
                        </div>
                        {timelineReport && (
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => {
                                setTempTimelineReport(timelineReport);
                                setIsEditingTimeline(true);
                              }}
                              className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs font-bold uppercase tracking-wider transition-all text-white border border-white/5"
                            >
                              Edit
                            </button>
                            <button
                              onClick={async () => {
                                const success = await copyToClipboard(timelineReport);
                                if (success) {
                                  alert("Timeline report copied to clipboard!");
                                } else {
                                  alert("Failed to copy report to clipboard.");
                                }
                              }}
                              className="px-4 py-2 bg-orange-500/15 text-orange-500 hover:bg-orange-500/20 rounded-xl text-xs font-bold uppercase tracking-wider transition-all border border-orange-500/10"
                            >
                              Copy Report
                            </button>
                          </div>
                        )}
                      </div>

                      {isEditingTimeline ? (
                        <div className="space-y-4">
                          <textarea
                            value={tempTimelineReport}
                            onChange={e => setTempTimelineReport(e.target.value)}
                            rows={20}
                            className="w-full bg-[#16191E] border border-white/10 rounded-2xl p-6 text-sm text-white font-mono leading-relaxed outline-none focus:border-orange-500 transition-colors resize-none"
                          />
                          <div className="flex justify-end gap-3">
                            <button
                              onClick={() => setIsEditingTimeline(false)}
                              className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs font-bold uppercase tracking-wider transition-all"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={handleSaveTimeline}
                              className="px-4 py-2 bg-orange-500 hover:bg-orange-600 rounded-xl text-xs font-bold uppercase tracking-wider transition-all text-white"
                            >
                              Save Changes
                            </button>
                          </div>
                        </div>
                      ) : timelineReport ? (
                        <ReportBody
                          markdown={timelineReport}
                          meta={timelineMeta}
                          truncated={timelineMeta?.truncated}
                          continuing={isGeneratingTimeline}
                          onContinue={() => handleGenerateTimeline('gateway')}
                        />
                      ) : (
                        <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-white/5 rounded-3xl text-center p-6 bg-[#16191E]/10">
                          <Calendar size={48} className="text-white/10 mb-4 animate-pulse" />
                          <h3 className="text-lg font-bold mb-1">No Timeline Report Generated</h3>
                          <p className="text-xs text-white/40 mb-6 max-w-sm leading-relaxed">
                            Generate a chronological case narrative and log using summaries from all recorded files in this case.
                          </p>
                          {isGeneratingTimeline ? (
                            <div className="flex flex-col items-center gap-3">
                              <Loader2 className="animate-spin text-orange-500" size={24} />
                              <span className="text-xs font-bold uppercase tracking-widest text-orange-500">Compiling timeline...</span>
                            </div>
                          ) : (
                            <div className="space-y-3">
                              {timelineError && <p className="text-xs text-red-300 max-w-md">{timelineError}</p>}
                              <button
                                onClick={() => handleGenerateTimeline('gateway')}
                                className="px-6 py-3 bg-orange-500 hover:bg-orange-600 rounded-xl font-bold text-sm transition-all flex items-center gap-2 text-white shadow-lg shadow-orange-500/10 mx-auto"
                              >
                                <Sparkles size={16} />
                                {timelineError ? 'Retry timeline' : 'Generate Case Timeline'}
                              </button>
                              {timelineError && allowGemini && !preferAssemblySummary && (
                                <button
                                  onClick={() => handleGenerateTimeline('gemini')}
                                  className="px-4 py-2 bg-white/10 hover:bg-white/15 rounded-xl text-xs font-bold"
                                >
                                  Send to Gemini instead
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {isSummaryExpanded && selectedRecording?.summary && (
          <div className="fixed inset-0 bg-black/95 backdrop-blur-md z-[120] flex flex-col p-6 sm:p-10">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-white/10">
              <div className="flex items-center gap-3">
                <FileText className="text-orange-500" size={24} />
                <div>
                  <h2 className="text-lg font-bold text-white">Full Case Narrative & Investigative Report</h2>
                  <p className="text-xs text-white/50">{selectedCase?.name} • {selectedRecording.original_name}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 flex-1 max-w-md mx-6">
                <div className="relative w-full">
                  <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/40" size={16} />
                  <input 
                    type="text"
                    placeholder="Filter or search terms inside Officer Narrative report..."
                    value={summaryFilter}
                    onChange={(e) => setSummaryFilter(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 bg-white/5 border border-white/10 rounded-xl text-xs text-white placeholder:text-white/40 focus:outline-none focus:border-orange-500/50"
                  />
                  {summaryFilter && (
                    <button 
                      onClick={() => setSummaryFilter('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-white/40 hover:text-white"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleCopyFinalSummary}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-orange-500 text-white text-xs font-bold transition-all"
                >
                  {finalCopySuccess ? <Check size={14} /> : <Copy size={14} />}
                  <span>{finalCopySuccess ? 'Copied' : 'Copy Final Summary'}</span>
                </button>
                <button 
                  onClick={handleCopySummary}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-all"
                >
                  {copySuccess ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                  <span>{copySuccess ? 'Copied' : 'Copy Text'}</span>
                </button>
                <button 
                  onClick={handlePrintReport}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-all"
                >
                  <Printer size={14} />
                  <span>Print Report</span>
                </button>
                <button 
                  onClick={() => setIsSummaryExpanded(false)}
                  className="p-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-all"
                  title="Close Fullscreen View"
                >
                  <Minimize2 size={18} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto pr-2 space-y-4">
              <div className="max-w-4xl mx-auto">
                <ReportBody
                  markdown={selectedRecording.summary}
                  filter={summaryFilter}
                  meta={selectedRecording.report_meta}
                  truncated={selectedRecording.report_meta?.truncated}
                  continuing={isRegeneratingSummary}
                  onContinue={() => handleRegenerateSummary()}
                />
              </div>
            </div>
          </div>
        )}

        {isConverting && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-zinc-900 border border-white/10 p-8 rounded-3xl max-w-md w-full text-center space-y-6 shadow-2xl"
            >
              <div className="relative w-24 h-24 mx-auto">
                <div className="absolute inset-0 border-4 border-white/5 rounded-full" />
                <svg className="absolute inset-0 w-full h-full -rotate-90">
                  <circle
                    cx="48"
                    cy="48"
                    r="44"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="4"
                    className="text-orange-500 transition-all duration-300"
                    strokeDasharray={2 * Math.PI * 44}
                    strokeDashoffset={2 * Math.PI * 44 * (1 - (Number(conversionProgress) || 0) / 100)}
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-xl font-bold">{conversionProgress}%</span>
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="text-xl font-bold">Converting Media</h3>
                <p className="text-sm text-white/40">This file format is not natively supported. We are converting it to MP3 for playback.</p>
              </div>
              <div className="w-full bg-white/5 h-1 rounded-full overflow-hidden">
                <motion.div 
                  className="h-full bg-orange-500"
                  initial={{ width: 0 }}
                  animate={{ width: `${conversionProgress}%` }}
                />
              </div>
            </motion.div>
          </div>
        )}
      </div>
    </div>
  );
}
