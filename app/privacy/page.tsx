import type { Metadata } from "next";
import { PrivacyContent } from "@/components/PrivacyContent";
import { privacyContact } from "@/lib/privacy-contact";

export const metadata: Metadata = { title: "Privacy" };

/** Static: no session, no database. The contact address is the only runtime input. */
export default function Privacy() {
  return <PrivacyContent contact={privacyContact()} />;
}
