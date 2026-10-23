package fr.sirius_assistant.app;

final class PlaybackProgress {
    static final long STALL_MS = 15000;
    private long progressedAt;
    private int position;

    PlaybackProgress(long now) { progressedAt = now; }

    boolean stalled(int currentPosition, long now) {
        if (currentPosition != position) {
            position = currentPosition;
            progressedAt = now;
        }
        return now - progressedAt >= STALL_MS;
    }
}
