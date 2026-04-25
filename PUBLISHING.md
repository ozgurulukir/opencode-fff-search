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

1. **Create an npm account** (if you don't have one):
   - Go to https://www.npmjs.com/signup
   - Verify your email

2. **Login to npm from terminal:**
   ```bash
   npm login
   # Enter username, password, and email
   ```

3. **Publish the package:**
   ```bash
   cd ~/Projects/opencode-fff-search-plugin
   npm publish --access public
   ```

   Note: If this is a scoped package (e.g., `@yourname/opencode-fff-search`), use:
   ```bash
   npm publish --access public
   ```
   For unscoped packages, just `npm publish` (they're public by default).

4. **Verify:**
   Visit https://www.npmjs.com/package/opencode-fff-search (or your package name)

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
