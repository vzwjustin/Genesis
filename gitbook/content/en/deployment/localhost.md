# 🏠 Localhost Deployment

Run Genesis on your local machine for development and personal use.

---

## 📦 Installation

Install Genesis globally via npm:

```bash
npm install -g genesis
```

**Requirements:**
- Node.js 20 or higher
- npm 9 or higher

---

## 🚀 Starting the Server

Start Genesis with a single command:

```bash
genesis
```

The dashboard will automatically open in your browser at `http://localhost:3000`

**Default Configuration:**
- **Dashboard**: `http://localhost:3000`
- **API Endpoint**: `http://localhost:20128/v1`
- **Data Directory**: `~/.genesis`

---

## 🔧 Configuration

### Custom Data Directory

Set a custom data directory using environment variable:

```bash
DATA_DIR=/path/to/data genesis
```

### Custom Port

The API port (20128) and dashboard port (3000) are configured in the application. To change them, you'll need to modify the source code or use environment variables if supported.

---

## 🛑 Stopping the Server

Press `Ctrl+C` in the terminal where Genesis is running.

```bash
# In the terminal running genesis
^C  # Press Ctrl+C
```

The server will gracefully shut down and save all data.

---

## 🔄 Restarting the Server

Simply run the start command again:

```bash
genesis
```

All your configurations, API keys, and combos are preserved in the data directory.

---

## 📊 Updating Genesis

Update to the latest version:

```bash
npm update -g genesis
```

Check your current version:

```bash
npm list -g genesis
```

---

## 🔍 Troubleshooting

### Port Already in Use

If port 20128 or 3000 is already in use:

```bash
# Find process using the port (macOS/Linux)
lsof -i :20128
lsof -i :3000

# Kill the process
kill -9 <PID>
```

### Permission Errors

If you encounter permission errors during installation:

```bash
# Use sudo (not recommended)
sudo npm install -g genesis

# Or fix npm permissions (recommended)
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

### Data Directory Issues

If the data directory is not accessible:

```bash
# Check permissions
ls -la ~/.genesis

# Fix permissions
chmod 755 ~/.genesis
```

---

## 📁 Data Directory Structure

```
~/.genesis/
├── db.json           # Main database (providers, combos, settings)
├── logs/             # Application logs
└── cache/            # Temporary cache files
```

**Backup Your Data:**

```bash
# Backup
cp -r ~/.genesis ~/.genesis.backup

# Restore
cp -r ~/.genesis.backup ~/.genesis
```

---

## 🔗 Next Steps

- [Connect Providers](/providers/subscription.md)
- [Create Combos](/features/combos.md)
- [Integrate with CLI Tools](/integration/cursor.md)
