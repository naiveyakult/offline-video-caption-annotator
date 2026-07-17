#include <mpv/client.h>

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double monotonic_seconds(void) {
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return value.tv_sec + value.tv_nsec / 1000000000.0;
}

static void fail(mpv_handle *mpv, const char *message) {
    fprintf(stderr, "%s\n", message);
    if (mpv) mpv_terminate_destroy(mpv);
    exit(1);
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s VIDEO_PATH\n", argv[0]);
        return 2;
    }
    mpv_handle *mpv = mpv_create();
    if (!mpv) fail(NULL, "mpv_create failed");
    const char *audio_output = getenv("MPV_SMOKE_AO");
    if (!audio_output || !audio_output[0]) audio_output = "null";
    mpv_set_option_string(mpv, "config", "no");
    mpv_set_option_string(mpv, "load-scripts", "no");
    mpv_set_option_string(mpv, "vid", "no");
    mpv_set_option_string(mpv, "ao", audio_output);
    if (mpv_initialize(mpv) < 0) fail(mpv, "mpv_initialize failed");

    const char *command[] = {"loadfile", argv[1], "replace", NULL};
    if (mpv_command(mpv, command) < 0) fail(mpv, "loadfile failed");

    bool loaded = false;
    int end_error = 0;
    const double deadline = monotonic_seconds() + 8.0;
    while (monotonic_seconds() < deadline) {
        mpv_event *event = mpv_wait_event(mpv, 0.1);
        if (event->event_id == MPV_EVENT_FILE_LOADED) loaded = true;
        if (event->event_id == MPV_EVENT_END_FILE) {
            mpv_event_end_file *end = event->data;
            if (end && end->reason == MPV_END_FILE_REASON_ERROR) end_error = end->error;
        }
        double position = 0.0;
        int64_t audio_id = 0;
        int64_t sample_rate = 0;
        if (loaded
            && mpv_get_property(mpv, "time-pos", MPV_FORMAT_DOUBLE, &position) >= 0
            && mpv_get_property(mpv, "aid", MPV_FORMAT_INT64, &audio_id) >= 0
            && mpv_get_property(mpv, "audio-params/samplerate", MPV_FORMAT_INT64, &sample_rate) >= 0
            && position >= 0.75) {
            char *codec = mpv_get_property_string(mpv, "audio-codec-name");
            printf("decoded audio: codec=%s aid=%lld sample_rate=%lld time=%.2f ao=%s\n",
                   codec ? codec : "unknown", (long long)audio_id,
                   (long long)sample_rate, position, audio_output);
            mpv_free(codec);
            mpv_terminate_destroy(mpv);
            return 0;
        }
        if (end_error < 0) {
            fprintf(stderr, "playback failed: %s\n", mpv_error_string(end_error));
            mpv_terminate_destroy(mpv);
            return 1;
        }
    }
    fail(mpv, loaded ? "audio decoder did not become ready" : "file did not load");
    return 1;
}
