import React from "react";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[ui] render error:", error.message);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen bg-[#0F1115] text-white flex items-center justify-center p-8">
        <div className="max-w-lg space-y-4">
          <h1 className="text-2xl font-bold">Narrative AI hit a problem</h1>
          <p className="text-sm text-white/70">
            The window caught an error before it could go blank. Your cases are still saved on this computer.
          </p>
          <pre className="text-xs text-red-200 whitespace-pre-wrap bg-red-500/10 border border-red-500/30 rounded-xl p-3">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-xl bg-orange-500 font-bold text-sm"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
