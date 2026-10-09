import Link from "next/link";
import { BrandLogo } from "../../components/brand-logo";
import { PasswordLinkRequest } from "../../components/password-link-request";

export default function Join() {
  return <main className="identity-page"><div className="identity-panel">
    <BrandLogo className="identity-brand" />
    <h1>Set up your account</h1>
    <p>Your invitation to Auto Math Facts stays valid while your account is active. Enter your invited email to get a fresh link to create or reset your password.</p>
    <PasswordLinkRequest />
    <p className="muted">Already have a password? <Link href="/">Sign in</Link>.</p>
  </div></main>;
}
