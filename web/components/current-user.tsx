export function CurrentUser({ name, role }: { name: string; role: string }) {
  return <div className="current-user" aria-label={`Current user: ${name}, ${role}`}>
    <div className="current-user-details"><span>{role}</span><strong>{name}</strong></div>
  </div>;
}
