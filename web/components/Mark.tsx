/** Errand's mark: an "e" with the full stop from the wordmark. Same drawing as /icon.svg. */
export function Mark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" rx="116" fill="#1a1917" />
      <path d="M128 262h184a92 92 0 1 0-26 66" fill="none" stroke="#f6f4ef" strokeWidth="44" />
      <circle cx="372" cy="340" r="32" fill="#e2531f" />
    </svg>
  );
}
