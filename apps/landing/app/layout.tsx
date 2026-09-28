import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'KaziAI AgentOS — Durable Autonomous Agent Operating System',
  description: 'Orchestrate, observe, approve, and execute self-healing multi-agent swarms with deterministic state machines, WAL checkpoints, and sandboxed MicroVM isolation.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased selection:bg-slate-800 selection:text-white">
        {children}
      </body>
    </html>
  );
}
