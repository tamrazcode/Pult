/** App mark: centered 2x2 block grid, matching the application icon. */
export function PultLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      role="img"
      aria-label="pult"
      className={className}
      fill="currentColor"
    >
      <rect x="106" y="81" width="140" height="140" rx="26" />
      <rect x="266" y="81" width="140" height="140" rx="26" />
      <rect x="106" y="241" width="140" height="190" rx="26" />
      <rect x="266" y="241" width="140" height="140" rx="26" />
    </svg>
  );
}
