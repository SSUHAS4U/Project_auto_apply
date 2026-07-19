import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Icon } from './Icon';
import { AssistantPage } from '../pages/AssistantPage';

/**
 * Floating chat launcher (bottom-right) that opens the Assistant in a slide-up panel —
 * the assistant is reachable from anywhere without occupying a nav slot. Hidden on the
 * full /assistant page (no point doubling it) and on the Resumes workbench (full-bleed
 * editor where an overlay button gets in the way).
 */
export function AssistantWidget() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  if (pathname.startsWith('/assistant') || pathname.startsWith('/resumes')) return null;

  return (
    <>
      {open && (
        <div className="chatw-panel" role="dialog" aria-label="Assistant">
          <div className="chatw-head">
            <span className="meta-item" style={{ fontWeight: 700 }}><Icon name="bot" size={16} /> Assistant</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} aria-label="Close chat">
              <Icon name="x" size={15} />
            </button>
          </div>
          <div className="chatw-body">
            <AssistantPage embedded />
          </div>
        </div>
      )}
      <button className={`chatw-fab ${open ? 'open' : ''}`} onClick={() => setOpen((v) => !v)}
        title="Assistant" aria-label={open ? 'Close assistant' : 'Open assistant'}>
        <Icon name={open ? 'x' : 'chat'} size={22} />
      </button>
    </>
  );
}
