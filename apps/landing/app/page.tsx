'use client';

import React, { useState } from 'react';
import {
  Sparkles,
  ArrowRight,
  CheckCircle2,
  Copy,
  Check,
  Terminal,
  ShieldCheck,
  Database,
  Zap,
  Activity,
  Layers,
  GitBranch,
  TrendingUp,
  Cpu,
  GitCommit,
  Play,
  Search,
  Target,
  ShieldAlert,
  GitPullRequest,
  HardDrive,
  AlertTriangle,
  FileCode,
  Server,
  Brain,
  UserCheck,
  Send,
  Sliders,
  ChevronRight
} from 'lucide-react';

const ICON_MAP: Record<string, React.ElementType> = {
  Sparkles,
  ArrowRight,
  CheckCircle2,
  Terminal,
  ShieldCheck,
  Database,
  Zap,
  Activity,
  Layers,
  GitBranch,
  TrendingUp,
  Cpu,
  GitCommit,
  Play,
  Search,
  Target,
  ShieldAlert,
  GitPullRequest,
  HardDrive,
  AlertTriangle,
  FileCode,
  Server,
  Brain,
  UserCheck,
  Send,
  Sliders
};

export default function LandingPage() {
  const [copied, setCopied] = useState(false);
  const installCmd = "npm install @kaziai/agentos @kaziai/core";

  const copyToClipboard = () => {
    navigator.clipboard.writeText(installCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const features = [
    {
        "title": "Deterministic Durability",
        "desc": "Write-ahead logging checkpoints every agent state transition. Never lose progress to server restarts or API rate-limiting.",
        "icon": "ShieldCheck"
    },
    {
        "title": "Human-in-the-Loop Gates",
        "desc": "Configurable approval policies intercept destructive tool calls (filesystem, cloud infrastructure, financial APIs) before execution.",
        "icon": "UserCheck"
    },
    {
        "title": "MicroVM Sandboxing",
        "desc": "Execute untrusted code, shell scripts, and MCP server tools inside micro-second isolated runtime sandboxes.",
        "icon": "Terminal"
    },
    {
        "title": "Agent Swarm Pub/Sub",
        "desc": "High-throughput asynchronous event bus coordinating multi-agent handoffs, parallel subagent delegations, and consensus voting.",
        "icon": "Cpu"
    }
];
  const stats = [
    {
        "val": "100%",
        "label": "Deterministic Recovery"
    },
    {
        "val": "<12ms",
        "label": "Handoff Latency"
    },
    {
        "val": "Zero",
        "label": "State Loss Crashes"
    },
    {
        "val": "SOC2",
        "label": "Compliance Ready"
    }
];
  const codeSnippet = "// Define durable agent task\nconst swarm = new AgentOS({\n  runtime: 'microvm-isolated',\n  checkpointStore: 'postgres-wal',\n  approvalPolicies: [Policies.REQUIRE_ADMIN_FOR_WRITE]\n});\n\nawait swarm.execute({\n  mission: 'Audit dependency CVEs and generate verified PR',\n  agents: ['SecurityResearcher', 'CodeModifier', 'VerifierBot']\n});";

  return (
    <div className="min-h-screen bg-[#07090E] text-slate-100 selection:bg-indigo-500/30 selection:text-indigo-300 relative overflow-hidden font-sans">
      {/* Background Glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[500px] bg-gradient-to-b from-indigo-600/15 via-blue-900/5 to-transparent blur-3xl pointer-events-none -z-10" />

      {/* Navigation */}
      <nav className="border-b border-slate-800/80 bg-[#090D16]/80 backdrop-blur-md sticky top-0 z-50 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-400 via-blue-500 to-indigo-600 flex items-center justify-center font-black text-white shadow-lg">
              K
            </div>
            <div>
              <span className="font-extrabold text-lg tracking-tight text-white">KaziAI AgentOS</span>
              <span className="hidden sm:inline-block ml-2 text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700/60">
                v2.4 Production Ready
              </span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <a href="#features" className="text-sm font-medium text-slate-400 hover:text-white transition hidden md:block">Features</a>
            <a href="#architecture" className="text-sm font-medium text-slate-400 hover:text-white transition hidden md:block">Architecture</a>
            <button
              onClick={copyToClipboard}
              className="hidden sm:flex items-center gap-2 text-xs font-mono bg-slate-900 border border-slate-800 hover:border-slate-700 px-3 py-1.5 rounded-lg text-slate-300 transition"
            >
              <span>{installCmd}</span>
              {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} className="text-slate-400" />}
            </button>
            <a
              href="#demo"
              className="px-4 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-600 text-white shadow-md hover:brightness-110 transition flex items-center gap-1.5"
            >
              Deploy Swarm <ChevronRight size={14} />
            </a>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="max-w-5xl mx-auto pt-20 pb-16 px-6 text-center">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-slate-800/80 border border-slate-700/60 text-slate-300 text-xs font-semibold mb-6">
          <Sparkles size={14} className="text-yellow-400" />
          <span>Next-Generation Architecture</span>
          <span className="text-slate-500">•</span>
          <span className="text-slate-400">Durable Autonomous Agent Operating System</span>
        </div>

        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-white leading-[1.15] mb-6">
          The Durable Execution Operating System for Autonomous AI Agents
        </h1>

        <p className="text-lg sm:text-xl text-slate-300 max-w-3xl mx-auto leading-relaxed mb-10 font-normal">
          Orchestrate, observe, approve, and execute self-healing multi-agent swarms with deterministic state machines, WAL checkpoints, and sandboxed MicroVM isolation.
        </p>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-12">
          <button
            onClick={() => alert('Launched KaziAI AgentOS!')}
            className="w-full sm:w-auto px-7 py-3.5 rounded-xl font-bold text-sm bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-600 text-white shadow-xl hover:scale-[1.02] active:scale-[0.98] transition flex items-center justify-center gap-2"
          >
            <span>Deploy Swarm</span>
            <ArrowRight size={16} />
          </button>
          <button
            onClick={copyToClipboard}
            className="w-full sm:w-auto px-6 py-3.5 rounded-xl font-mono text-xs bg-slate-900/90 border border-slate-800 text-slate-300 hover:bg-slate-800/80 hover:border-slate-700 transition flex items-center justify-center gap-3"
          >
            <Terminal size={15} className="text-indigo-400" />
            <span>{installCmd}</span>
            {copied ? <Check size={14} className="text-emerald-400 ml-1" /> : <Copy size={14} className="text-slate-400 ml-1" />}
          </button>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl mx-auto pt-6 border-t border-slate-800/60">
          {stats.map((s: {val: string; label: string}, idx: number) => (
            <div key={idx} className="p-4 rounded-xl bg-slate-900/40 border border-slate-800/50">
              <div className="text-2xl sm:text-3xl font-black bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-600 bg-clip-text text-transparent">
                {s.val}
              </div>
              <div className="text-xs text-slate-400 mt-1 font-medium">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Interactive Code / Architecture Showcase */}
      <section id="demo" className="max-w-5xl mx-auto px-6 py-12">
        <div className="rounded-2xl border border-slate-800 bg-[#0B0F19] overflow-hidden shadow-2xl shadow-black/80">
          <div className="px-5 py-3.5 bg-slate-900/90 border-b border-slate-800/90 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-500/80" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
              <div className="w-3 h-3 rounded-full bg-green-500/80" />
              <span className="text-xs text-slate-400 font-mono ml-2">Live Agent Swarm State Machine</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Production Ready
              </span>
            </div>
          </div>
          <div className="p-6 font-mono text-xs sm:text-sm text-slate-300 overflow-x-auto leading-relaxed bg-[#090D16]/60">
            <pre className="text-slate-300">
              <code>{codeSnippet}</code>
            </pre>
          </div>
        </div>
      </section>

      {/* Feature Cards Grid */}
      <section id="features" className="max-w-6xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <h2 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
            Engineered for Production Reliability
          </h2>
          <p className="text-sm text-slate-400 mt-2 max-w-xl mx-auto">
            Comprehensive developer primitives designed to withstand heavy scale, adversarial inputs, and distributed execution.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {features.map((f: {title: string; desc: string; icon: string}, i: number) => {
            const Icon = ICON_MAP[f.icon] || Sparkles;
            return (
              <div
                key={i}
                className="p-6 rounded-2xl bg-slate-900/40 border border-slate-800/80 hover:border-slate-700 transition group hover:shadow-xl"
              >
                <div className="w-11 h-11 rounded-xl bg-slate-800/60 border border-slate-700/80 flex items-center justify-center text-indigo-400 mb-4 group-hover:scale-110 transition">
                  <Icon size={22} />
                </div>
                <h3 className="text-base font-bold text-white mb-2">{f.title}</h3>
                <p className="text-xs sm:text-sm text-slate-400 leading-relaxed font-normal">{f.desc}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Architecture / Pipeline Section */}
      <section id="architecture" className="max-w-5xl mx-auto px-6 py-16">
        <div className="rounded-2xl border border-slate-800/90 bg-gradient-to-b from-slate-900/60 to-slate-950 p-8 sm:p-12 relative overflow-hidden">
          <div className="max-w-2xl">
            <div className="text-xs font-bold uppercase tracking-wider text-indigo-400 mb-2">
              Execution Architecture
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight mb-4">
              Deterministic, Observable, and Scalable
            </h2>
            <p className="text-sm text-slate-300 leading-relaxed mb-6">
              Built on a foundation of strict type safety, zero unnecessary network hops, and multi-layered verification routines. Connects seamlessly with existing microservices and cloud runtimes.
            </p>
            <div className="space-y-3">
              <div className="flex items-center gap-3 text-xs sm:text-sm text-slate-300">
                <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
                <span>Zero telemetry lock-in — Deploy air-gapped on bare metal or cloud.</span>
              </div>
              <div className="flex items-center gap-3 text-xs sm:text-sm text-slate-300">
                <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
                <span>Full TypeScript SDK & REST endpoints for programmatic control.</span>
              </div>
              <div className="flex items-center gap-3 text-xs sm:text-sm text-slate-300">
                <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
                <span>First-class Model Context Protocol (MCP) tool server integration.</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Bottom CTA Banner */}
      <section className="max-w-5xl mx-auto px-6 pb-24 text-center">
        <div className="p-10 rounded-3xl bg-gradient-to-r from-slate-900 via-slate-900/90 to-slate-900 border border-slate-800 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 blur-[90px] pointer-events-none" />
          <h2 className="text-3xl sm:text-4xl font-extrabold text-white mb-4">
            Ready to integrate KaziAI AgentOS?
          </h2>
          <p className="text-sm sm:text-base text-slate-400 max-w-xl mx-auto mb-8">
            Install the open-source release or launch the standalone dashboard in seconds.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={() => alert('Launched KaziAI AgentOS!')}
              className="px-8 py-3.5 rounded-xl font-bold text-sm bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-600 text-white shadow-xl hover:brightness-110 transition"
            >
              Get Started with KaziAI AgentOS
            </button>
            <button
              onClick={copyToClipboard}
              className="px-6 py-3.5 rounded-xl font-mono text-xs bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-750 transition flex items-center gap-2"
            >
              <span>{installCmd}</span>
              <Copy size={14} />
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-[#06080D] py-10 px-6 text-xs text-slate-500">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-tr from-cyan-400 via-blue-500 to-indigo-600 flex items-center justify-center font-bold text-white text-[10px]">
              K
            </div>
            <span className="font-bold text-slate-300">KaziAI AgentOS</span>
            <span>© 2026. Open Source Software.</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="#features" className="hover:text-slate-300 transition">Features</a>
            <a href="#demo" className="hover:text-slate-300 transition">Interactive Demo</a>
            <a href="#architecture" className="hover:text-slate-300 transition">Architecture</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
