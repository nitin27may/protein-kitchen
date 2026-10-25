import { EmptyState, LinkButton, PageTitle } from "@/components/ui";

/**
 * What a visitor without an account sees on a page that is about their own household. It carries no household data
 * at all: a short explanation and the two ways forward.
 */
export function AnonymousPrompt({ title, sub, heading, body }: { title: string; sub?: string; heading: string; body: string }) {
  return (
    <>
      <PageTitle title={title} sub={sub} />
      <EmptyState
        title={heading}
        body={body}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <LinkButton href="/plan/new">Create a plan</LinkButton>
            <LinkButton href="/sign-in" variant="secondary">Sign in</LinkButton>
          </div>
        }
      />
    </>
  );
}
