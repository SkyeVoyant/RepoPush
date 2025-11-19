# RepoPush (Open Source)

A **lightweight** tool that automatically syncs local git repositories to GitHub using fine-grained tokens. 

**Not meant to replace enterprise-grade solutions** - RepoPush is a simple, minimal alternative that uses virtually no resources when idle and only a tiny bit when actively pushing. Perfect for personal projects or small setups that need basic automated syncing without the overhead.

## Features

- **Ultra-lightweight** - Uses minimal resources (virtually zero when idle, tiny footprint when syncing)
- Uses GitHub fine-grained tokens for authentication
- Supports multiple projects from a single `.env` file
- Reads `.env` file fresh on every sync (no in-memory caching)
- Syncs all branches and tags
- Configurable sync interval
- Runs in Docker
- Simple, single-purpose design - no bloat

## Prerequisites

- Docker and Docker Compose
- GitHub fine-grained personal access token with appropriate permissions

## Getting Started

1. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/repopush.git
   cd repopush
   ```

2. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

3. Create a GitHub fine-grained token:
   - Go to GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens
   - Create a new token with the following permissions:
     - **Contents**: Read and write
     - **Metadata**: Read (required)
   - Optionally add **Administration**: Read if repository settings restrict branch creation

4. Edit `.env` and configure:
   - Your GitHub fine-grained token
   - Sync interval (in minutes)
   - Projects path (`PROJECTS_PATH`) - the directory where your local git repositories are located
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

# Sync interval in minutes (default: 60)
sync_time = 60

# Path to your projects directory (used for Docker volume mounting)
PROJECTS_PATH = /path/to/your/projects

# Project 1
gitlink = https://github.com/username/repo-name
gitlocation = /path/to/your/projects/project-name

# Project 2
gitlink = https://github.com/username/another-repo
gitlocation = /path/to/your/projects/another-project
```

## How It Works

1. Reads `.env` file on every sync (no caching)
2. For each configured project:
   - Sets up GitHub remote with token authentication
   - Pushes all local branches to GitHub
   - Pushes all tags to GitHub
   - Uses force push to ensure all commits are synced

## Notes

- The sync interval (`sync_time`) only changes on container restart
- All other config (token, projects) is read fresh on every sync
- Projects must be valid git repositories
- The tool will push all branches and tags, not just the current branch
- Uses force push to ensure all commits are synced (be careful with shared repositories)

## Troubleshooting

### Permission Denied Errors

If you see permission errors when pushing:
- Verify your token has **Contents: Read and write** permission
- Check that the token has access to the repositories you're trying to sync
- Ensure the repositories exist on GitHub before syncing

### Container Issues

- View logs: `docker-compose logs -f`
- Restart container: `docker-compose restart`
- Stop container: `docker-compose down`

## License

This project is licensed under the GNU General Public License v2.0. See the [LICENSE](LICENSE) file for details.

