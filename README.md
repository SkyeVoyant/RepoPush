# RepoPush (Open Source)

A **lightweight** tool that automatically commits file changes and syncs local git repositories to GitHub using fine-grained tokens. 

**Not meant to replace enterprise-grade solutions** - RepoPush is a simple, minimal alternative that uses virtually no resources when idle and only a tiny bit when actively monitoring and syncing. Perfect for personal projects or small setups that need basic automated syncing without the overhead.

## Features

- **Auto-commit on file changes** - Monitors your projects and commits every detectable change
- **Respects .gitignore** - Won't commit files that are gitignored
- **Smart debouncing** - Groups rapid changes together to avoid excessive commits
- **Timed GitHub sync** - Pushes to GitHub at configurable intervals (not on every commit)
- **Auto-creates repositories** - Creates private GitHub repos if they don't exist
- **GitHub identity** - Uses your GitHub profile for commits (name, email, avatar)
- **Ultra-lightweight** - Uses minimal resources (virtually zero when idle)
- Uses GitHub fine-grained tokens for authentication
- Supports multiple projects from a single `.env` file
- Syncs all branches and tags
- Configurable sync interval and commit debounce
- Runs in Docker
- Simple, single-purpose design - no bloat

## How It Works

1. **Startup**: On startup, RepoPush will:
   - Initialize file watchers for all projects
   - Commit any uncommitted changes in all projects
   - Perform initial sync to GitHub

2. **File Watching**: Monitors all configured projects for file changes using chokidar

3. **Auto-Commit**: When changes are detected (respecting `.gitignore`):
   - Waits for a debounce period (default 3 seconds) to group rapid changes
   - Stages all changes with `git add -A`
   - Commits with timestamp: `Auto backup 2025-11-19T12:34:56.789Z`

4. **Timed Sync**: At configured intervals (default 60 minutes):
   - Checks if GitHub repository exists (creates as private if it doesn't)
   - Pushes all commits to GitHub
   - Syncs all branches and tags
   - Uses your GitHub identity for all commits

## Prerequisites

- Docker and Docker Compose
- GitHub fine-grained personal access token with appropriate permissions

## Getting Started

1. Clone this repository:
   ```bash
   git clone https://github.com/SkyeVoyant/repopush.git
   cd repopush
   ```

2. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

3. Create a GitHub fine-grained token:
   - Go to GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens
   - Create a new token with the following permissions:
     - **Contents**: Read and write (required)
     - **Metadata**: Read (required)
     - **Administration**: Read and write (optional - for auto-creating repositories)
   - If you skip Administration permission, RepoPush will keep retrying until you manually create the repo

4. Edit `.env` and configure:
   - Your GitHub fine-grained token
   - **Git author name and email** - Your name and email for commits (will show on GitHub)
   - Push interval (in minutes) - how often to sync to GitHub
   - Commit debounce (in milliseconds) - how long to wait before committing changes
   - Projects to sync (gitlink and gitlocation pairs)

5. Build and run with Docker Compose:
   ```bash
   docker-compose up -d --build
   ```

## Security Note

⚠️ **Never commit your `.env` file to version control!** It contains your GitHub token. The `.env` file is already included in `.gitignore`.

## .env Format

```env
# GitHub Fine-Grained Token
token = your_github_token_here

# Git Commit Author Information
# This will be used for all automated commits
git_author_name = Your Name
git_author_email = your.email@example.com

# Push interval in minutes (default: 60)
# This controls how often changes are pushed to GitHub
sync_time = 60

# Commit debounce in milliseconds (default: 3000)
# This controls how long to wait before committing detected changes
# Helps group rapid changes into a single commit
commit_debounce_ms = 3000

# Project 1
gitlink = https://github.com/username/repo-name
gitlocation = /path/to/your/projects/project-name

# Project 2
gitlink = https://github.com/username/another-repo
gitlocation = /path/to/your/projects/another-project
```

## What Gets Committed

RepoPush will commit **all detectable changes** EXCEPT:
- Files and directories in `.gitignore`
- Hidden files and directories (starting with `.`)
- `node_modules/`, `dist/`, `build/`, `logs/`, `tmp/`, `cache/`, `coverage/`
- `.log` and `.tmp` files
- The `.git` directory itself

## Commit Identity

RepoPush uses the git author information from your `.env` file:
- **git_author_name** - Your name as it appears on commits
- **git_author_email** - Your email (must match a verified email on your GitHub account for contributions to count)
- Your commits will show your GitHub profile picture if the email matches your GitHub account
- **Important**: Make sure the email is verified in your GitHub settings for commits to count toward your contribution graph

## Example Workflow

1. You edit a file in your project → RepoPush detects the change
2. You make a few more rapid edits → RepoPush waits (debounce)
3. After 3 seconds of no changes → RepoPush commits with message "Auto backup 2025-11-19T12:34:56.789Z"
4. You continue working, making more changes and commits throughout the day
5. Every 60 minutes → RepoPush pushes all accumulated commits to GitHub
6. GitHub shows your profile picture and name on all commits

## Why Separate Commit and Push?

Committing frequently ensures you never lose work, but pushing on every commit would spam GitHub's servers. This approach:
- **Commits immediately** - Your work is always saved locally
- **Pushes periodically** - GitHub isn't overwhelmed with requests
- **Respects rate limits** - No risk of hitting GitHub API limits
- **Better for rapid changes** - Make 100 edits in 5 minutes? Get ~1-2 commits, not 100 pushes

## Troubleshooting

### Permission Errors

**For pushing code:**
- Verify your token has **Contents: Read and write** permission
- Check that the token has access to the repositories you're trying to sync

**For auto-creating repositories (optional):**
- Add **Administration: Read and write** permission to your token
- For user repos: Token must be from the same user
- For org repos: Token must have access to the organization
- **Without this permission**: RepoPush will still work! It will:
  - Warn you that the repo doesn't exist
  - Skip pushing for that repo
  - Automatically retry on the next sync interval
  - Succeed once you manually create the repo on GitHub

### Container Issues

- View logs: `docker-compose logs -f`
- Restart container: `docker-compose restart`
- Stop container: `docker-compose down`

### File Changes Not Detected

- Check that the file is not in `.gitignore`
- Verify the project path is correct in `.env`
- Check logs for watcher errors

### Too Many Commits

- Increase `commit_debounce_ms` to wait longer before committing
- Example: `commit_debounce_ms = 10000` (10 seconds)

## Notes

- The sync interval (`sync_time`) only changes on container restart
- Commit debounce changes on container restart
- Projects must be valid git repositories
- Uses force push to ensure all commits are synced
- File watching works recursively on all subdirectories

## License

This project is licensed under the GNU General Public License v2.0. See the [LICENSE](LICENSE) file for details.
