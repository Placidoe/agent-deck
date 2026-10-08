// An editable, single-color deck mark, shared by navigation and the Main Agent.
export function BrandMark({ className = "", ...props }) {
  return <svg className={`brand-mark ${className}`.trim()} viewBox="0 0 32 32" fill="none" aria-hidden="true" {...props}>
    <path d="M5 13.5 15 6a2 2 0 0 1 2 0l10 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".35" />
    <path d="m5 18 10-7.5a2 2 0 0 1 2 0L27 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".65" />
    <path d="M5 23.5 15 16a2 2 0 0 1 2 0l10 7.5-10 6a2 2 0 0 1-2 0l-10-6Z" fill="currentColor" />
    <path d="m12 23 4-3 4 3" stroke="var(--brand-cutout, #1c2433)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
