# OrdDashboard

A comprehensive note analytics and spaced repetition plugin for Obsidian that helps you track note engagement and optimize your knowledge retention.

## Features

### Analytics Dashboard
- **Note Statistics**: Track total notes, views, edits, and active notes
- **Engagement Metrics**: View most active notes with detailed view/edit counts
- **Search Functionality**: Quick search across all notes with instant results

### Spaced Repetition System
- **Smart Refresh Reminders**: Automatically calculates when notes need review based on spaced repetition algorithms
- **5-Stage System**: Progressive intervals (7 days → 14 days → 30 days → 60 days → 120 days)
- **Visual Progress Tracking**: Color-coded progress bars and deadline indicators
- **Overdue Detection**: Highlights notes that have passed their review deadline

### Note Tracking
- **Automatic Activity Tracking**: Records when notes are opened, viewed, and edited
- **Recent Activity**: Shows recently opened and frequently accessed notes
- **Comprehensive History**: Maintains detailed view and edit history for each note

### Multilingual Support
- **Russian and English**: Automatic language detection based on Obsidian settings
- **Fallback System**: Defaults to English for all other languages

## Installation

### From Obsidian Community Plugins
1. Open Obsidian Settings
2. Go to Community Plugins
3. Search for "OrdDashboard"
4. Install and enable the plugin

### Manual Installation
1. Download the latest release from GitHub
2. Extract the files to `[vault]/.obsidian/plugins/ord-dashboard/`
3. Enable the plugin in Obsidian Settings > Community Plugins

## Usage

### Opening the Dashboard
- **Ribbon Icon**: Click the home icon in the left ribbon
- **Command Palette**: Search for "Open OrdDashboard"
- **Hotkey**: Assign a custom hotkey in Settings > Hotkeys

### Dashboard Sections

#### Statistics
View overall vault metrics including total notes, views, edits, and monthly active notes.

#### Search
Type to search across all notes with real-time filtering and keyboard navigation.

#### Spaced Repetition
Review notes that need refreshing based on the spaced repetition algorithm:
- **Initial Stage** (7 days): New or recently accessed notes
- **Second Stage** (14 days): Notes that have been reviewed once
- **Monthly Stage** (30 days): Established notes
- **Two-Month Stage** (60 days): Well-known notes
- **Four-Month Stage** (120 days): Deeply familiar notes

#### Recently Active
Shows notes opened in the last week or with significant recent activity.

#### All Notes
Complete list of all notes sorted by creation date with metadata.

### Commands

The plugin provides several commands accessible via Command Palette:

- **Open OrdDashboard**: Opens the main dashboard
- **Clear Analytics Data**: Removes all tracking data (with confirmation)
- **Initialize Existing Notes**: Processes existing notes for tracking

## Data Storage

The plugin stores analytics data in `[vault]/.obsidian/plugins/ord-dashboard/note-views.json`. This file contains:
- View counts and timestamps
- Edit history
- Spaced repetition stage information
- Note metadata

## Privacy

All data is stored locally in your vault. No data is transmitted to external servers.

## Configuration

The plugin works out of the box with no configuration required. Language is automatically detected from Obsidian settings.

## Development

### Building
The plugin is built using vanilla JavaScript and doesn't require a build process.

### File Structure
- `main.js`: Core plugin logic and UI
- `manifest.json`: Plugin metadata
- `styles.css`: Dashboard styling
- `versions.json`: Version compatibility information

### API Compatibility
- Minimum Obsidian version: 0.15.0
- Compatible with desktop and mobile versions

## Release Process

This plugin follows the official Obsidian plugin submission process:

1. **Create Release**: Tag version and create GitHub release with `main.js`, `manifest.json`, and `styles.css`
2. **Submit to Community**: Create pull request to [obsidian-releases](https://github.com/obsidianmd/obsidian-releases)
3. **Review Process**: Wait for community review and approval

## Changelog

### 0.0.1
- Initial release
- Analytics dashboard with statistics and engagement metrics
- Spaced repetition system with 5-stage progression
- Multilingual support (Russian/English)
- Search functionality
- Automatic note tracking

## License

MIT License

## Support

For issues, feature requests, or questions, please visit the [GitHub repository](https://github.com/Ordnungen/ord-dashboard).
