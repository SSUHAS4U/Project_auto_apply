import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Icon } from './Icon';
import { AssistantPage } from '../pages/AssistantPage';
import { LiveView } from './AutomationPanels';
import { TerminalConsole } from './DesktopTerminal';
import { isDesktopApp } from '../lib/desktop';

/**
 * Floating hub (bottom-right) — one launcher for everything that used to be scattered across
 * the header: the AI Assistant, the automation's live screen (Watch live), and the desktop
 * Terminal. It opens a slide-up panel with tabs and NEVER navigates away, so it works the
 * same on every page (including Auto Apply). The Terminal tab only appears inside the desktop
 * app. Hidden on the full /assistant page and the Resumes workbench.
 */
type Tab = 'chat' | 'live' | 'terminal';

export function AssistantWidget() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('chat');
  const { pathname } = useLocation();
  if (pathname.startsWith('/assistant') || pathname.startsWith('/resumes')) return null;

  const hasTerminal = isDesktopApp();
  const TABS: { key: Tab; label: string; icon: string }[] = [
    { key: 'chat', label: 'Assistant', icon: 'bot' },
    { key: 'live', label: 'Watch live', icon: 'live' },
    ...(hasTerminal ? [{ key: 'terminal' as Tab, label: 'Terminal', icon: 'terminal' }] : []),
  ];

  return (
    <>
      {open && (
        <div className="hub-panel" role="dialog" aria-label="JobPilot hub">
          <div className="hub-head">
            <div className="hub-tabs">
              {TABS.map((t) => (
                <button key={t.key} className={`hub-tab ${tab === t.key ? 'active' : ''}`}
                  onClick={() => setTab(t.key)}>
                  <Icon name={t.icon} size={14} /> {t.label}
                </button>
              ))}
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} aria-label="Close">
              <Icon name="x" size={15} />
            </button>
          </div>
          <div className="hub-body">
            {/* keep-mounted so switching tabs doesn't drop the chat thread or the live poll */}
            <div style={{ display: tab === 'chat' ? 'block' : 'none', height: '100%' }}>
              <AssistantPage embedded />
            </div>
            {tab === 'live' && <div className="hub-pane"><LiveView /></div>}
            {tab === 'terminal' && hasTerminal && <div className="hub-pane"><TerminalConsole /></div>}
          </div>
        </div>
      )}
      <button className={`chatw-fab ${open ? 'open' : ''}`} onClick={() => setOpen((v) => !v)}
        title="Assistant · Watch live · Terminal" aria-label={open ? 'Close hub' : 'Open hub'}>
        <Icon name={open ? 'x' : 'sparkles'} size={22} />
      </button>
    </>
  );
}
