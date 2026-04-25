# Publishing Instructions

## GitHub

1. **Create a new repository on GitHub:**
   - Go to https://github.com/new
   - Repository name: `opencode-fff-search` (or your preferred name)
   - Choose public or private
 - Do NOT initialize with README, .gitignore, or license (we already have these)

2. **Link your local repo and push:**

   ```bash
   cd ~/Projects/opencode-fff-search-plugin

   # Replace ozgurulukir with your GitHub username
   git remote add origin https://github.com/ozgurulukir/opencode-fff-search.git

   # Push to GitHub
   git branch -M main
   git push -u origin main
   ```

3. **Update repository URL in package.json:**
   Edit `package.json` and update the `repository.url` field:
   ```json
   "repository": {
     "type": "git",
     "url": "https://github.com/ozgurulukir/opencode-fff-search.git"
   }
   ```

4. **Commit and push the change:**
   ```bash
   git add package.json
   git commit -m "Update repository URL"
   git push
   ```

## npm

**⚠️ Prerequisite:** You must be logged into npm before publishing.

1. **Check current login status:**
   ```bash
   npm whoami
   ```

   If not logged in, proceed to step 2. If already logged in, skip to step 3.

2. **Login to npm:**
   ```bash
   npm login
   # Enter username, password, and email (use one-time password if 2FA enabled)
   ```

   For accounts with 2FA, you'll need an OTP. After `npm login`, you may need:
   ```bash
   npm profile enable-2fa  # if not already enabled
   ```

3. **Publish the package:**
   ```bash
   cd ~/Projects/opencode-fff-search-plugin
   npm publish --access public
   ```

   Expected output:
   ```
   npm notice 📦  opencode-fff-search@0.2.0
   npm notice Tarball Contents ...
   + opencode-fff-search@0.2.0
   ```

4. **Verify publication:**
   ```bash
   npm view opencode-fff-search version
   # Should output: 0.2.0
   ```
   Or visit: https://www.npmjs.com/package/opencode-fff-search

**Troubleshooting:**
- **"need auth" or "ENEEDAUTH"** → Run `npm login` first
- **"You do not have permission to publish"** → Ensure you own the package name (check with `npm whoami`)
- **"Package name already taken"** → The package `opencode-fff-search` is already published by another user. You'll need to use a scoped name like `@yourusername/opencode-fff-search` and update `package.json` accordingly.
- **2FA required** → After `npm login`, you'll be prompted for OTP. If publishing fails with "needs 2FA", run `npm publish --otp <your-otp>`.

---

## Quick Checklist (Current Status)

- [x] GitHub repository created: https://github.com/ozgurulukir/opencode-fff-search
- [x] README with full installation/usage docs
- [x] LICENSE (MIT)
- [x] Git tags and releases created (v0.1.0, v0.1.1, v0.2.0)
- [x] Plugin tested and verified working
- [x] README updated with npm installation method
- [ ] **npm login performed** ← *This is the only remaining step*
- [ ] npm package published (once logged in)

## Post-Publish

1. **Update installation instructions** in README to show npm method:
   ```json
   {
     "plugin": ["opencode-fff-search"]
   }
   ```

2. **Create a release on GitHub:**
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
   Then go to GitHub repository → Releases → Create new release from tag.

3. **Share it!**
   - Post on [OpenCode Discord](https://opencode.ai/discord)
   - Submit to [OpenCode ecosystem](/docs/ecosystem)
   - Share on social media

## Updating the Package

When making changes:

1. Update version in `package.json` (semver: major.minor.patch)
2. Commit and push
3. Create a git tag: `git tag v0.1.1`
4. Push tag: `git push origin v0.1.1`
5. npm publish (same command)
6. Create GitHub release from the tag

## Troubleshooting

**"You do not have permission to publish"**
- Make sure you're logged in: `npm whoami`
- For scoped packages, the scope must be owned by your account

**"Package name already taken"**
- Choose a unique name (try prefixing with your username: `@yourname/...`)
- Check availability: `npm view <package-name>`

**"Missing required field: description"**
- Ensure `package.json` has a `description` field

**Binary not found after install**
The `@ff-labs/fff-node` package includes optional native binaries. They should install automatically. If not, users can manually install the appropriate package for their platform (e.g., `@ff-labs/fff-bin-linux-x64-gnu`).
