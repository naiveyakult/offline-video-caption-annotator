#ifndef OFFLINE_VIDEO_ANNOTATOR_MPV_BRIDGE_H
#define OFFLINE_VIDEO_ANNOTATOR_MPV_BRIDGE_H

#include <stdbool.h>
#include <stddef.h>

typedef struct {
    double x;
    double y;
    double width;
    double height;
} ova_mpv_bounds;

typedef struct {
    bool ready;
    double duration;
    double current_time;
    bool paused;
    double volume;
    bool muted;
    bool ended;
    bool has_audio;
    char error[512];
} ova_mpv_state;

bool ova_mpv_probe(char *error, size_t error_size);
void *ova_mpv_create(void *parent_view, ova_mpv_bounds bounds, char *error, size_t error_size);
bool ova_mpv_load(void *player, const char *path, double initial_position, char *error, size_t error_size);
bool ova_mpv_set_bounds(void *player, ova_mpv_bounds bounds, char *error, size_t error_size);
bool ova_mpv_get_state(void *player, ova_mpv_state *state, char *error, size_t error_size);
bool ova_mpv_play(void *player, char *error, size_t error_size);
bool ova_mpv_pause(void *player, char *error, size_t error_size);
bool ova_mpv_seek(void *player, double position, char *error, size_t error_size);
bool ova_mpv_set_volume(void *player, double volume, char *error, size_t error_size);
bool ova_mpv_set_muted(void *player, bool muted, char *error, size_t error_size);
void ova_mpv_destroy(void *player);

#endif
