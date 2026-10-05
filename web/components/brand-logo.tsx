export function BrandLogo({ className = "" }: { className?: string }) {
  return <div className={`brand spark-brand ${className}`} role="img" aria-label="Auto Math Facts">
    <svg className="spark-brand-mark" viewBox="0 0 76 84" aria-hidden="true" focusable="false">
      <path fill="currentColor" fillRule="evenodd" d="M35 4C36 1 38 1 39 4C44 29 49 36 68 42C71 43 71 45 68 46C49 51 44 59 39 80C38 83 36 83 35 80C30 59 23 51 4 46C1 45 1 43 4 42C23 37 30 29 35 4ZM29 38a3 3 0 0 0 0 6h17a3 3 0 0 0 0-6H29ZM29 48a3 3 0 0 0 0 6h17a3 3 0 0 0 0-6H29Z"/>
      <circle className="spark-brand-dot" cx="64" cy="18" r="6"/>
    </svg>
    <div className="spark-brand-type" aria-hidden="true"><span className="spark-brand-auto">Auto</span><span className="spark-brand-name">Math Facts</span></div>
  </div>;
}
