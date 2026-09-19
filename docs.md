1. The Core Features (What the User Does)

    Authentication: * Sign Up (Username/Password). Rule: Username must be unique.

        Login (Session-based or Token-based).

    Vertical Feed:

        Full-screen video player.

        "Infinite" scroll (fetching the next video when the user swipes).

    Interactions:

        Like/Unlike Toggle: (The most important logic—checking if a user already liked a video).

        Comments: A list of text tied to a specific video_id.

        Dislikes: (Optional, but same logic as likes).

    Upload:

        Pick a video file from the phone/PC.

        Save file to the PC's /uploads folder.

        Add a new entry to the database.

2. The Technical Stack (The "Guts")

The AI needs to know these exact tools so it doesn't suggest alternatives mid-way:

    Server: Python (Flask).

    Database: SQLite (a single file named tiktok.db).

    Media Storage: Local filesystem (a folder named /videos).

    Mobile Framework: React Native with Expo (essential for making the APK easily).

    Networking: Axios (for API calls) and Ngrok (to bridge your PC to your phone).

3. The Database Schema (The "Memory")

The AI must follow this structure, or the "Like" and "Comment" features will break:

    users table: id, username (UNIQUE), password (HASHED).

    videos table: id, filename, description, uploader_id, created_at.

    likes table: user_id, video_id. (This table is how we handle Unliking).

    comments table: id, video_id, user_id, comment_text, timestamp.

4. The "Connection" Details

The AI often forgets that a phone and a PC are different devices. It needs to know:

    Base URL: The app must use a variable for the API URL (e.g., const API_URL = "http://YOUR_PC_IP:5000").

    CORS Policy: The Backend must allow all "origins" so the APK isn't blocked by security.

    File Streaming: The backend must be able to "serve static files" so the phone can actually play the .mp4.

5. Error Handling Requirements

Tell the AI these are Non-Negotiable:

    409 Conflict: Return this if a username is taken.

    401 Unauthorized: Return this if a password is wrong.

    Loading States: The frontend must show a spinner while a video is loading or uploading.

    Try/Catch: Every single function must have a "Catch" that alerts the user to the specific error.