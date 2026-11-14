/** Project mark: four skewed rounded squares (one tall). Inherits currentColor. */
export function PultLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 320 320"
      role="img"
      aria-label="pult"
      className={className}
      fill="currentColor"
    >
      <g transform="translate(22 0) skewX(-12)">
        <rect x="94" y="87" width="55" height="55" rx="11" />
        <rect x="165" y="87" width="55" height="55" rx="11" />
        <rect x="94" y="158" width="55" height="75" rx="11" />
        <rect x="165" y="158" width="55" height="55" rx="11" />
      </g>
    </svg>
  );
}
