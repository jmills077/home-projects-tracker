// The pages shown before someone is signed in: sign in, first-time setup, joining a household from an
// invite link, and setting a new password from a reset link. Plain forms, so they work without the app script.
import type { Child } from 'hono/jsx';
import { Layout } from './layout';

const Shell = ({ title, children }: { title: string; children: Child }) => (
  <Layout title={`${title} · Home Projects`}>
    <header class="top"><span class="brand">Home Projects</span></header>
    <main><div class="card login">{children}</div></main>
  </Layout>
);

const Err = ({ error }: { error?: string }) => error ? <p class="note err">{error}</p> : null;

const Field = ({ label, name, type = 'text', auto, value, hint }: { label: string; name: string; type?: string; auto?: string; value?: string; hint?: string }) => (
  <label class="f"><span>{label}</span>
    <input type={type} name={name} autocomplete={auto} value={value} required
      {...(type === 'password' && auto === 'new-password' ? { minlength: 8 } : {})} />
    {hint && <small class="hint">{hint}</small>}
  </label>
);

export const LoginPage = ({ error, email, next }: { error?: string; email?: string; next?: string }) => (
  <Shell title="Sign in">
    <h1>Sign in</h1>
    <Err error={error} />
    <form method="post" action="/login">
      {next && <input type="hidden" name="next" value={next} />}
      <Field label="Email" name="email" type="email" auto="username" value={email} />
      <Field label="Password" name="password" type="password" auto="current-password" />
      <p><button class="btn primary" type="submit">Sign in</button></p>
    </form>
    <p class="muted small">New here? <a href="/signup">Make an account</a> with the sign-up link you were sent, or ask
      someone in your household for an invite link to share theirs.</p>
    <p class="muted small">Forgot your password? Ask your household's owner, or whoever sent you the site, for a link to set a new one.</p>
  </Shell>
);

/** Before anyone has an account: the first one is made with the old site password and gets everything made so far. */
export const SetupPage = ({ error, name, email, noSitePassword }: { error?: string; name?: string; email?: string; noSitePassword?: boolean }) => (
  <Shell title="Set up your account">
    <h1>Set up your account</h1>
    {noSitePassword ? (
      <p>No site password is set, so nobody can set up the first account yet. Set the <code>APP_PASSWORD</code> secret
        in Cloudflare (or in <code>.dev.vars</code> locally), then reload this page.</p>
    ) : (<>
      <p>Everyone now signs in with their own email and password. Make yours first: you'll own the household, and
        every project and receipt already here moves into it. Then you can invite others from Settings.</p>
      <Err error={error} />
      <form method="post" action="/setup">
        <Field label="Site password (the one you used until now)" name="site_password" type="password" auto="off" />
        <Field label="Your name" name="name" auto="name" value={name} />
        <Field label="Email" name="email" type="email" auto="username" value={email} />
        <Field label="New password" name="password" type="password" auto="new-password" hint="At least 8 characters." />
        <p><button class="btn primary" type="submit">Make my account</button></p>
      </form>
    </>)}
  </Shell>
);

/** Anyone with the site's sign-up link: an account and a household of their own. */
export const SignUpPage = ({ open, code, error, name, email, household }: {
  open: boolean; code?: string; error?: string; name?: string; email?: string; household?: string;
}) => (
  <Shell title="Make an account">
    <h1>Make an account</h1>
    {open ? (<>
      <p>Home Projects keeps your house projects and woodworking builds in one place: budgets and what you've spent,
        to-do and shopping lists, cut lists, receipts and a calendar. Your projects are your own. Invite the people
        you live with from Settings once you're in.</p>
      <Err error={error} />
      <form method="post" action="/signup">
        {code ? <input type="hidden" name="code" value={code} />
          : <Field label="Sign-up code (from the link you were sent)" name="code" auto="off" />}
        <Field label="Your name" name="name" auto="name" value={name} />
        <Field label="Email" name="email" type="email" auto="username" value={email} hint="You sign in with it. Nothing is ever emailed to you." />
        <Field label="Password" name="password" type="password" auto="new-password" hint="At least 8 characters." />
        <label class="f"><span>Name for your household (optional)</span>
          <input name="household" value={household} placeholder="The Smith house" autocomplete="off" /></label>
        <p><button class="btn primary" type="submit">Make my account</button></p>
      </form>
    </>) : (
      <p>Sign-up is turned off right now. Ask whoever sent you the site for a sign-up link, or ask someone in your
        household for an invite link.</p>
    )}
    <p class="muted small">Already have an account? <a href="/login">Sign in</a>.</p>
  </Shell>
);

export const JoinPage = ({ token, household, by, error, name, email, signedInAs }: {
  token: string; household: string; by: string; error?: string; name?: string; email?: string; signedInAs?: string;
}) => (
  <Shell title={`Join ${household}`}>
    <h1>Join {household}</h1>
    <p>{by} invited you to share their projects. Everyone in the household can see and change them.</p>
    <Err error={error} />
    {signedInAs ? (
      <form method="post" action={`/join/${token}`}>
        <p class="muted">You're signed in as {signedInAs}.</p>
        <p><button class="btn primary" type="submit">Join {household}</button></p>
      </form>
    ) : (<>
      <form method="post" action={`/join/${token}`}>
        <Field label="Your name" name="name" auto="name" value={name} />
        <Field label="Email" name="email" type="email" auto="username" value={email} />
        <Field label="Password" name="password" type="password" auto="new-password" hint="At least 8 characters." />
        <p><button class="btn primary" type="submit">Make my account and join</button></p>
      </form>
      <p class="muted small">Already have an account? <a href={`/login?next=${encodeURIComponent(`/join/${token}`)}`}>Sign in first</a>, then you can join.</p>
    </>)}
  </Shell>
);

export const ResetPage = ({ token, name, error }: { token: string; name: string; error?: string }) => (
  <Shell title="Set a new password">
    <h1>Set a new password</h1>
    <p>For {name}. You'll be signed out on your other devices.</p>
    <Err error={error} />
    <form method="post" action={`/reset/${token}`}>
      <Field label="New password" name="password" type="password" auto="new-password" hint="At least 8 characters." />
      <p><button class="btn primary" type="submit">Save and sign in</button></p>
    </form>
  </Shell>
);

export const DeadLinkPage = () => (
  <Shell title="Link not working">
    <h1>This link isn't working</h1>
    <p>It has run out (links last 7 days) or was already used. Ask for a new one.</p>
    <p><a class="btn" href="/login">Go to sign in</a></p>
  </Shell>
);
