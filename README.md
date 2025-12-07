# RepoPush (Open Source)

**Simple, automatic backup system for your projects to GitHub.**

Monitors your projects and automatically commits every change locally, then syncs to GitHub at regular intervals.

## What it does

1. **Watches for file changes** in all configured projects
2. **Commits immediately** when changes are detected (respects `.gitignore`)
3. **Pushes to GitHub** every X minutes (configurable)
4. **Auto-creates private repos** if they don't exist on GitHub
5. **Full commit on startup** to catch any uncommitted changes

That's it. Simple, reliable backups with your GitHub identity.

## Features

- Commits every detectable change locally (debounced to avoid spam)
- Pushes to GitHub at configurable intervals (default: 60 minutes)
- **Auto-initializes git repos** - If a project directory doesn't have `.git`, it's initialized automatically
- Auto-creates GitHub repos if missing (requires Administration permission)
- Uses your name and email from `.env` for commits
- Respects `.gitignore` in each project
- **Hot-reload configuration** - Edit `.env` and changes apply automatically (no restart needed!)
- Lightweight and fast
- Runs in Docker

## Prerequisites

- Docker and Docker Compose
- GitHub fine-grained token with:
  - **Contents**: Read and write (required)
  - **Metadata**: Read (required)
  - **Administration**: Read and write (optional - for auto-creating repos)

## Quick start

1) **Install and configure**
```bash
cd repopush
cp .env.example .env
# Edit .env with your token, name, email, and projects
```

2) **Run**
```bash
docker compose up -d --build

# View logs
docker logs RepoPush -f
```

## Configuration

Create a `.env` file with these settings:

```bash
# GitHub token
token=your_github_token_here

# Your identity (shows on commits)
git_author_name=Your Name
git_author_email=your.email@example.com

# How often to push to GitHub (minutes)
sync_time=60

# How long to wait before committing changes (milliseconds)
commit_debounce_ms=3000

# Projects to sync
gitlink=https://github.com/username/repo-name
gitlocation=/path/to/your/projects/repo-name

gitlink=https://github.com/username/another-repo
gitlocation=/path/to/your/projects/another-repo
```

⚠️ **Important**: Use an email that's verified in your GitHub account for commits to count toward your contribution graph.

## How it works

- Watches all configured projects for file changes
- **Auto-initializes** git repositories if they don't exist (creates initial commit if files are present)
- Commits changes locally after 3 seconds of inactivity (debounced)
- Pushes all commits to GitHub every 60 minutes
- New projects are committed and pushed immediately (no waiting for file changes)
- Each project syncs independently
- Force pushes when needed (local is authoritative)
- Creates GitHub repos automatically if they don't exist

## Why separate commit and push?

- **Local commits** = Never lose work
- **Timed pushes** = Don't spam GitHub
- Make 100 edits in 5 minutes? You get ~1-2 commits, not 100 API requests.

## Troubleshooting

**No changes being committed?**
- Check that files aren't in `.gitignore`
- Verify paths in `.env` are correct
- Check logs: `docker logs RepoPush`

**New project not being pushed?**
- The project directory must exist (git will be auto-initialized if missing)
- If the directory is empty, git will be initialized but no commit will be created until files are added
- Check logs for initialization messages: `[project-name] Initializing git repository...`

**Push failures?**
- Verify token has **Contents: Read and write**
- Check that token has access to the repos
- For auto-creating repos: Add **Administration: Read and write**

**Commits not showing on GitHub profile?**
- Verify `git_author_email` matches a verified email in your GitHub settings
- Go to: Settings → Emails → Add/verify your email

**Too many commits?**
- Increase `commit_debounce_ms` to wait longer before committing
- Example: `commit_debounce_ms=10000` (10 seconds)

**Repo creation failed?**
- Add **Administration: Read and write** permission to your token
- Or manually create the repo on GitHub first

## Hot-reload Configuration

**No restart needed!** RepoPush automatically watches your `.env` file for changes:

- **Add new projects** - Just add them to `.env` and save. They'll be added automatically.
- **Remove projects** - Remove them from `.env` and they'll stop being watched.
- **Update settings** - Change `sync_time`, `commit_debounce_ms`, or credentials - changes apply immediately.

The app detects `.env` changes within 1 second and reloads the configuration automatically. You'll see `[Config] .env file changed, reloading configuration...` in the logs when it happens.

## Docker commands

```bash
# Start
docker compose up -d --build

# Stop
docker compose down

# View logs
docker logs RepoPush -f

# Restart (optional - hot-reload means restart not needed for .env changes)
docker compose restart
```

## License

GPL-2.0-only — see `LICENSE`.
