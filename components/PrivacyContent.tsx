import Link from "next/link";
import type { ReactNode } from "react";
import { CONTACT_NOT_SET, type PrivacyContact } from "@/lib/privacy-contact";

const link = "font-semibold text-primary underline-offset-2 hover:underline";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={id} aria-labelledby={`${id}-heading`} className="space-y-3">
    <h2 id={`${id}-heading`} className="text-xl font-semibold">{title}</h2>
    {children}
  </section>;
}

function List({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5">{children}</ul>;
}

export function PrivacyContent({ contact }: { contact: PrivacyContact }) {
  return <article className="mx-auto max-w-2xl space-y-8 px-4 pb-28 pt-8">
    <header className="space-y-3">
      <h1 className="text-2xl font-bold">Privacy</h1>
      <p>Protein Kitchen is a personal meal planner. This page lists what it stores, where it is kept, how your email address is used, and how to download or delete your data. It is not legal advice.</p>
    </header>

    <Section id="store" title="What we store">
      <List>
        <li><strong>Account:</strong> your email address and, if you gave one, your name. A password hash is stored only if you set a password.</li>
        <li><strong>Meal profile:</strong> your name, sex, birth date, height, weight, activity level, diet flags, protein and calorie targets, and reminder time and time zone.</li>
        <li><strong>Your kitchen:</strong> meal plans, shopping lists and pantry, ratings, favourites, notes, saved links and views, routines you choose, and prep and shopping ticks. These belong to your household and are shared with its members.</li>
        <li><strong>Photos you upload:</strong> re-encoded to WebP, with all metadata (camera details and location) removed. The original file is not kept.</li>
        <li><strong>Reminder devices:</strong> if reminders are switched on later, a push registration for each device you enable. Reminders are not on at launch.</li>
        <li><strong>A session cookie:</strong> a random sign-in token that keeps you signed in until it expires or you sign out. It is not used for tracking.</li>
        <li><strong>A mail log:</strong> to limit abuse we keep a one-way hash of the recipient address and the kind of email for up to 2 days. The address itself is not kept in this log.</li>
      </List>
      <p>The app has no advertising or analytics code. Our host and email provider keep their own operational logs.</p>
    </Section>

    <Section id="device" title="On this device">
      <List>
        <li><strong>Theme:</strong> your light or dark choice is kept in this browser until you change it or clear site data.</li>
        <li><strong>Plan draft before you sign up:</strong> a plan you build without an account, and the name and targets you enter for it, stay in this browser tab (session storage) and are discarded 14 days after the draft was made at the latest. An action you tried to save, such as a rating, is kept for up to 24 hours.</li>
        <li><strong>30-minute copy:</strong> when you start signing up, a copy of that draft is also written to local storage for 30 minutes so an email link opened in a new tab can find it. It expires after that.</li>
        <li><strong>Shopping ticks made offline:</strong> kept in this browser until they sync.</li>
      </List>
      <p>Nothing here is sent to our servers until you sign up and your draft is imported. Clearing site data removes it.</p>
    </Section>

    <Section id="email" title="How your email address is used">
      <List>
        <li>To send sign-in codes and links. They expire after five minutes.</li>
        <li>To send household notices, such as telling you that someone added your address to their household.</li>
      </List>
      <p>We do not send marketing email and we do not sell or share your address for advertising.</p>
    </Section>

    <Section id="where" title="Where your data is held">
      <List>
        <li><strong>Hosting:</strong> Vercel.</li>
        <li><strong>Database:</strong> Neon, in US East (Ohio).</li>
        <li><strong>Email delivery:</strong> Resend. It receives your address and the message when we send you a code or notice.</li>
        <li><strong>Photo storage:</strong> Neon object storage, in the same region.</li>
      </List>
    </Section>

    <Section id="backups" title="Backups">
      <p>Neon keeps 6 hours of database history on the plan we use. Before each release we also take a snapshot copy of the database and keep it for up to 7 days. Deleted data can therefore remain in these copies for up to 7 days.</p>
    </Section>

    <Section id="download" title="Download your data">
      <p>Sign in, open <Link href="/account" className={link}>Your account</Link> and choose Download my account. You get a JSON file with your account details, meal profile, preferences, routines, ratings and favourites. It does not include your household&rsquo;s shared plans or photos. Keep the file private.</p>
    </Section>

    <Section id="delete" title="Delete your account">
      <p>Open <Link href="/account" className={link}>Your account</Link> and choose Delete my account. You confirm with a six-digit code we email to you, or with your password if you set one, and by typing DELETE.</p>
      <p><strong>If you are the only member of your household,</strong> the household is deleted with you: your login and sessions, your meal profile (including birth date, height and weight), plans, shopping lists, pantry, prep, ratings, favourites, notes, links, saved views, routines, reminder devices, pending invitations and uploaded photos, including the photo files.</p>
      <p><strong>If other people share your household,</strong> your login, sessions, invitations, reminder devices, and your own ratings and favourites are removed. The household stays for the others, and so does your meal profile until an owner removes it. An owner must make another cook an owner first.</p>
      <p>Database backups can keep deleted data for up to 7 days, as described under Backups. The mail log keeps a hash for up to 2 days.</p>
    </Section>

    <Section id="contact" title="Contact">
      {contact.kind === "address"
        ? <p>For privacy questions or help with deletion, write to <a className={link} href={`mailto:${contact.email}`}>{contact.email}</a>.</p>
        : contact.kind === "not-set" ? <p>{CONTACT_NOT_SET}</p> : null}
    </Section>
  </article>;
}
