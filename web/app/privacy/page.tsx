import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy · ACM Trading Simulator",
  description: "What ACM Trading Simulator collects, how it is used and who can see it.",
};

const CONTACT = "anwar09102005@gmail.com";
const EFFECTIVE = "October 29, 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Contact() {
  return (
    <a href={`mailto:${CONTACT}`} className="text-accent hover:underline">
      {CONTACT}
    </a>
  );
}

export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-3xl space-y-8 pb-10 text-sm leading-relaxed text-foreground/90">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Privacy Policy</h1>
        <p className="text-muted">Effective {EFFECTIVE}</p>
        <p>
          ACM Trading Simulator is a practice market for the algorithmic trading competitions held by
          UChicago ACM, a student organization at the University of Chicago. Teams write trading bots,
          test them on sample data and run them against each other in live rounds. The app is run by
          Anwar Kader on behalf of UChicago ACM. Questions about this policy go to <Contact />.
        </p>
      </header>

      <Section title="What we collect">
        <p>
          <strong>From Google when you sign in:</strong> your name, email address, profile picture
          and Google account ID. We ask Google only for basic profile information (the{" "}
          <code>openid</code>, <code>email</code> and <code>profile</code> scopes). We have no access
          to your Gmail, Drive, contacts or anything else in your Google account.
        </p>
        <p>
          <strong>What you create in the app:</strong> the group you join, the code you save (with its
          title, language, author and time), and your group&apos;s activity in each round: the orders
          your bot sends, trades, positions, profit and loss, and final results.
        </p>
        <p>
          <strong>Technical data:</strong> cookies that keep you signed in, and the request logs our
          hosting providers keep to run and secure their services (IP address, browser type and the
          time of each request).
        </p>
        <p>
          <strong>Stored only in your browser:</strong> unsaved code drafts. They stay on your device
          and reach us only if you save them.
        </p>
        <p>We do not use analytics, advertising or tracking cookies.</p>
      </Section>

      <Section title="How we use it">
        <ul className="list-disc space-y-1 pl-5">
          <li>To sign you in and keep you signed in.</li>
          <li>To show your name and profile picture to the members of your group.</li>
          <li>To run trading rounds, score them and show leaderboards.</li>
          <li>To let organizers manage groups and rounds, and moderate submitted code.</li>
          <li>To keep the service secure and fix problems.</li>
        </ul>
        <p>We do not sell your information or use it for advertising.</p>
      </Section>

      <Section title="Google user data">
        <p>
          We use the information Google provides only to sign you in and to identify you inside the
          app. We do not transfer it to anyone except the service providers below that host the app,
          and we never use it for advertising. The app&apos;s use of information received from Google
          APIs adheres to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className="text-accent hover:underline"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </Section>

      <Section title="Who can see your information">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Anyone, without signing in:</strong> group names, market data from each round,
            leaderboards and final results by group.
          </li>
          <li>
            <strong>Members of your group:</strong> your name and profile picture, and all code saved
            by anyone in the group.
          </li>
          <li>
            <strong>Organizers:</strong> every participant&apos;s name, email address and group, and
            all saved code, so they can run the event.
          </li>
          <li>Other groups cannot see your email address or your group&apos;s code.</li>
        </ul>
        <p>Service providers that host the app process data on our behalf:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Supabase: database, sign-in and file storage (United States).</li>
          <li>Vercel: hosting for this website.</li>
          <li>Render: hosting for the exchange server that runs the market (United States).</li>
          <li>Google: sign-in.</li>
          <li>
            jsDelivr: the code editor and the Python, C and C++ tools are downloaded from its content
            network, which sees your IP address as any website does when you load files from it.
          </li>
        </ul>
        <p>We may disclose information if the law requires it.</p>
      </Section>

      <Section title="Your code runs in your browser">
        <p>
          Bots run inside a sandbox in your own browser. The exchange server receives only the orders
          your bot sends; it never runs your code.
        </p>
      </Section>

      <Section title="How long we keep it, and your choices">
        <p>
          We keep your account, saved code and round results until an organizer deletes them or you
          ask us to. Deleting a round removes its trading data.
        </p>
        <p>
          Email <Contact /> to ask for a copy of your data, to correct it, or to delete your account.
          Deleting your account removes your profile and group membership. Code you saved stays with
          your group without your name, unless you ask us to remove it too.
        </p>
        <p>
          You can also remove the app&apos;s access to your Google account at any time from your{" "}
          <a href="https://myaccount.google.com/permissions" className="text-accent hover:underline">
            Google account permissions
          </a>
          .
        </p>
      </Section>

      <Section title="Security">
        <p>
          Data is sent over HTTPS. Database access rules limit each person to the data described
          above, and the keys that bypass those rules are kept only on our servers. No system is
          perfectly secure, so we cannot guarantee absolute security.
        </p>
      </Section>

      <Section title="Children">
        <p>
          The app is meant for university students and is not directed to children under 13.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          If this policy changes, we will update this page and its effective date. Material changes
          will also be announced to participants.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Anwar Kader, for UChicago ACM: <Contact />
        </p>
        <p>
          <Link href="/" className="text-accent hover:underline">
            Back to the market
          </Link>
        </p>
      </Section>
    </article>
  );
}
