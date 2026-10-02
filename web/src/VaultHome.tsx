import { useId, useMemo } from "react";
import type { TreeEntry } from "./api";
import "./vault-home.css";

type VaultHomeProps = {
  vault: string;
  entries: TreeEntry[];
  readOnly: boolean;
  onOpen: (path: string) => void;
  onCreate: () => void;
  onSearch: () => void;
};

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={diagonal ? "M6 18 18 6M6 6h12v12" : "M4 12h15m-6-6 6 6-6 6"} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function LibrarySculpture() {
  const id = useId().replace(/:/g, "");
  return <figure className="home-sculpture" aria-label="An abstract sculpture of concentric paper forms">
    <svg className="home-sculpture-art" viewBox="0 0 460 360" role="img" aria-label="Concentric elliptical lines form a floating paper sculpture">
      <defs>
        <linearGradient id={`${id}-paper`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--home-paper-start)" /><stop offset="1" stopColor="var(--home-paper-end)" /></linearGradient>
        <linearGradient id={`${id}-ink`} x1="0" y1="0" x2=".8" y2="1"><stop stopColor="var(--home-ink-start)" /><stop offset=".52" stopColor="var(--home-ink-middle)" /><stop offset="1" stopColor="var(--home-ink-end)" /></linearGradient>
      </defs>
      <path className="home-art-guide" d="M22 181h416M230 24v305" fill="none" stroke="currentColor" strokeWidth=".5" strokeDasharray="2 6" />
      <ellipse cx="234" cy="294" rx="122" ry="8" fill="var(--home-ink-middle)" opacity=".055" />
      <circle cx="332" cy="107" r="68" fill="var(--accent)" opacity=".11" />
      <g transform="translate(230 177) rotate(-32)">
        <path d="M-174 0C-174-71-94-115 0-115S174-71 174 0C174 72 94 115 0 115S-174 72-174 0Z" fill={`url(#${id}-paper)`} />
        {Array.from({ length: 38 }, (_, index) => {
          const t = index / 37;
          const rx = 174 - t * 111;
          const ry = 115 - t * 78;
          const center = t * 16;
          return <ellipse key={index} cx={center} cy={-t * 11} rx={rx} ry={ry} transform={`rotate(${t * 13} ${center} ${-t * 11})`} fill="none" stroke={`url(#${id}-ink)`} strokeWidth={index % 5 === 0 ? 1.1 : .7} opacity={.72 + t * .24} />;
        })}
        <ellipse cx="16" cy="-11" rx="59" ry="33" transform="rotate(13 16 -11)" fill="var(--home-paper-center)" />
        <ellipse cx="16" cy="-11" rx="59" ry="33" transform="rotate(13 16 -11)" fill="none" stroke="var(--home-ink-start)" strokeWidth=".8" />
      </g>
      <g className="home-art-registration" stroke="currentColor" strokeWidth=".7"><path d="M24 32h10m-5-5v10M426 310h10m-5-5v10" /></g>
      <circle cx="368" cy="257" r="3" fill="var(--accent)" />
      <path d="m369 256 36-27h20" fill="none" stroke="var(--accent)" strokeWidth=".7" />
    </svg>
    <figcaption><span>FIG. 01</span><span>A little space for possibility.</span></figcaption>
  </figure>;
}

function noteTitle(note: TreeEntry) { return note.name.replace(/\.md$/i, ""); }
function noteFolder(note: TreeEntry) { return note.path.includes("/") ? note.path.slice(0, note.path.lastIndexOf("/")).replaceAll("/", " / ") : "Vault root"; }

export default function VaultHome({ vault, entries, readOnly, onOpen, onCreate, onSearch }: VaultHomeProps) {
  const { notes, folders } = useMemo(() => {
    const notes: TreeEntry[] = [];
    let folders = 0;
    const visit = (items: TreeEntry[]) => items.forEach(item => {
      if (item.type === "markdown") notes.push(item);
      if (item.type === "directory") { folders += 1; visit(item.children ?? []); }
    });
    visit(entries);
    return { notes, folders };
  }, [entries]);
  const [first, ...rest] = notes.slice(0, 5);

  return <div className="vault-home">
    <div className="home-inner">
      <div className="home-masthead"><span><i aria-hidden="true" />YOUR PERSONAL LIBRARY</span><span className="home-vault-name" title={vault}>{vault}</span></div>
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero-copy">
          <p className="home-eyebrow">A quiet place for curious minds</p>
          <h1 id="home-title">Room for<br /><em>a little wonder.</em></h1>
          <p className="home-intro">Thoughts worth keeping. Ideas worth connecting.<br className="home-desktop-break" /> Make yourself at home in your library.</p>
          <div className="home-hero-actions">
            {!readOnly && <button className="home-create" onClick={onCreate}><span className="home-plus" aria-hidden="true">+</span>Create a note<Arrow /></button>}
            <button className="home-search" onClick={onSearch}>{readOnly ? "Explore your library" : "Find a thought"}<Arrow /></button>
          </div>
        </div>
        <LibrarySculpture />
      </section>

      <section className="home-library" aria-labelledby="home-library-title">
        <div className="home-section-heading">
          <div><span className="home-section-index" aria-hidden="true">01 /</span><h2 id="home-library-title">On your shelves</h2><span className="home-note-count">{notes.length}</span></div>
          {!!notes.length && <button onClick={onSearch}>Search all notes<Arrow diagonal /></button>}
        </div>
        {first ? <div className={`home-shelves${rest.length ? "" : " home-shelves-single"}`}>
          <button className="home-featured-note" onClick={() => onOpen(first.path)}>
            <span className="home-featured-top"><span>OPEN A PAGE</span><svg viewBox="0 0 34 36" fill="none" aria-hidden="true"><path d="M5 8h12c5-4 10-5 13-4v24c-4-1-8 0-13 4-5-4-9-5-13-4V4c4 0 9 1 13 4v24M8 9c2 0 4 1 6 2m-6 3c2 0 4 1 6 2m-6 3c2 0 4 1 6 2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
            <strong>{noteTitle(first)}</strong>
            <span className="home-featured-bottom"><span title={first.path}>{noteFolder(first)}</span><span className="home-featured-arrow"><Arrow diagonal /></span></span>
          </button>
          {!!rest.length && <div className="home-note-list">
            {rest.map((note, index) => <button className="home-note-row" key={note.path} onClick={() => onOpen(note.path)}>
              <span className="home-note-number">{String(index + 2).padStart(2, "0")}</span>
              <span className="home-note-name"><strong>{noteTitle(note)}</strong><small title={note.path}>{noteFolder(note)}</small></span>
              <Arrow diagonal />
            </button>)}
          </div>}
        </div> : <div className="home-empty-shelf"><span className="home-empty-symbol" aria-hidden="true">✳</span><div><h3>Every library begins with a thought.</h3><p>{readOnly ? "This library is waiting for its first notes." : "A passing idea, a useful link, a story to return to. Start anywhere."}</p></div>{!readOnly && <button onClick={onCreate}>Write your first note<Arrow /></button>}</div>}
      </section>
      <footer className="home-footer"><span>{notes.length} {notes.length === 1 ? "note" : "notes"}<i aria-hidden="true">·</i>{folders} {folders === 1 ? "folder" : "folders"}</span><span>A collection, always becoming.</span></footer>
    </div>
  </div>;
}
