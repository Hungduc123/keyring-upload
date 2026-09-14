This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Accounts and project access

Accounts live in the `APP_USERS` environment variable: a JSON array on a single
line. An `admin` sees every project; an `editor` sees only the projects listed
for it, both in the UI and in the API.

```
APP_USERS='[{"username":"admin","password":"...","role":"admin"},{"username":"keyring-one","password":"...","role":"editor","projects":["keyring-one"]}]'
```

| Field      | Required | Notes                                                            |
| ---------- | -------- | ---------------------------------------------------------------- |
| `username` | yes      | Login name.                                                      |
| `password` | yes      | Plain text; keep it in the env var, never in the repo.           |
| `role`     | no       | `admin` or `editor`. Defaults to `editor`.                       |
| `projects` | editors  | Project keys this account may use. Admins get all of them.       |

Valid project keys are the ones in `PROJECTS` in [`src/lib/upstash.ts`](src/lib/upstash.ts):
`keyring-app`, `coinpool`, `coinpool-prod`, `nft-viewer`, `keyring-one`. An
unknown key makes login fail with an explicit configuration error rather than
silently granting nothing.

`ADMIN_USERNAME` / `ADMIN_PASSWORD` still work and count as an admin, so an
existing deployment keeps working before `APP_USERS` is set. An `APP_USERS`
entry with the same username takes precedence.

Roles are resolved from the environment on every request, not stored in the
session cookie — removing an account signs it out at once, and every API route
re-checks project access, so a limited account cannot reach another project by
editing the request.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
