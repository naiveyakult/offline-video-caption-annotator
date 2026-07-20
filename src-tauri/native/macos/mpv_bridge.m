#import "mpv_bridge.h"

#import <Cocoa/Cocoa.h>
#import <OpenGL/gl.h>
#import <dlfcn.h>

#include <stdint.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct mpv_handle mpv_handle;
typedef struct mpv_render_context mpv_render_context;

typedef struct {
    int type;
    void *data;
} mpv_render_param;

typedef struct {
    void *(*get_proc_address)(void *ctx, const char *name);
    void *get_proc_address_ctx;
} mpv_opengl_init_params;

typedef struct {
    int fbo;
    int w;
    int h;
    int internal_format;
} mpv_opengl_fbo;

typedef struct {
    int event_id;
    int error;
    uint64_t reply_userdata;
    void *data;
} mpv_event;

typedef struct {
    int reason;
    int error;
} mpv_event_end_file;

typedef struct {
    const char *prefix;
    const char *level;
    const char *text;
    int log_level;
} mpv_event_log_message;

enum {
    MPV_FORMAT_FLAG = 3,
    MPV_FORMAT_INT64 = 4,
    MPV_FORMAT_DOUBLE = 5,
    MPV_EVENT_NONE = 0,
    MPV_EVENT_LOG_MESSAGE = 2,
    MPV_EVENT_END_FILE = 7,
    MPV_EVENT_FILE_LOADED = 8,
    MPV_END_FILE_REASON_EOF = 0,
    MPV_END_FILE_REASON_ERROR = 4,
    MPV_RENDER_PARAM_API_TYPE = 1,
    MPV_RENDER_PARAM_OPENGL_INIT_PARAMS = 2,
    MPV_RENDER_PARAM_OPENGL_FBO = 3,
    MPV_RENDER_PARAM_FLIP_Y = 4,
};

typedef struct {
    void *library;
    mpv_handle *(*create)(void);
    int (*set_option_string)(mpv_handle *, const char *, const char *);
    int (*initialize)(mpv_handle *);
    int (*request_log_messages)(mpv_handle *, const char *);
    void (*terminate_destroy)(mpv_handle *);
    int (*command)(mpv_handle *, const char **);
    int (*get_property)(mpv_handle *, const char *, int, void *);
    int (*set_property)(mpv_handle *, const char *, int, void *);
    mpv_event *(*wait_event)(mpv_handle *, double);
    const char *(*error_string)(int);
    int (*render_create)(mpv_render_context **, mpv_handle *, mpv_render_param *);
    void (*render_set_update_callback)(mpv_render_context *, void (*)(void *), void *);
    int (*render)(mpv_render_context *, mpv_render_param *);
    void (*render_free)(mpv_render_context *);
} ova_mpv_api;

typedef struct ova_mpv_player ova_mpv_player;

@interface OvaMpvOpenGLView : NSOpenGLView
@property(nonatomic, assign) ova_mpv_player *player;
- (void)renderFrame;
@end

struct ova_mpv_player {
    ova_mpv_api api;
    mpv_handle *handle;
    mpv_render_context *render_context;
    __strong OvaMpvOpenGLView *view;
    bool ready;
    bool ended;
    bool initial_seek_pending;
    double initial_position;
    _Atomic int render_error;
    char last_error[512];
};

static void write_error(char *destination, size_t size, const char *message) {
    if (!destination || size == 0) return;
    snprintf(destination, size, "%s", message ? message : "unknown libmpv error");
}

static bool load_symbol(void *library, void **target, const char *name, char *error, size_t error_size) {
    *target = dlsym(library, name);
    if (*target) return true;
    char message[512];
    snprintf(message, sizeof(message), "libmpv 缺少符号 %s", name);
    write_error(error, error_size, message);
    return false;
}

static void *open_library(char *error, size_t error_size) {
    const char *override = getenv("LIBMPV_PATH");
    if (override && override[0]) {
        void *library = dlopen(override, RTLD_NOW | RTLD_LOCAL);
        if (library) return library;
        const char *detail = dlerror();
        char message[768];
        snprintf(message, sizeof(message), "LIBMPV_PATH 加载失败：%s", detail ? detail : "unknown dlopen error");
        write_error(error, error_size, message);
        return NULL;
    }

    NSString *frameworks = NSBundle.mainBundle.privateFrameworksPath;
    if (!frameworks) {
        write_error(error, error_size, "无法定位应用的 Frameworks 目录");
        return NULL;
    }

    NSFileManager *files = NSFileManager.defaultManager;
    NSString *versioned = [frameworks stringByAppendingPathComponent:@"libmpv.2.dylib"];
    if ([files fileExistsAtPath:versioned]) {
        void *library = dlopen(versioned.fileSystemRepresentation, RTLD_NOW | RTLD_LOCAL);
        if (library) return library;
        const char *detail = dlerror();
        char message[768];
        snprintf(message, sizeof(message), "libmpv.2.dylib 加载失败：%s", detail ? detail : "unknown dlopen error");
        write_error(error, error_size, message);
        return NULL;
    }

    NSString *alias = [frameworks stringByAppendingPathComponent:@"libmpv.dylib"];
    if ([files fileExistsAtPath:alias]) {
        void *library = dlopen(alias.fileSystemRepresentation, RTLD_NOW | RTLD_LOCAL);
        if (library) return library;
        const char *detail = dlerror();
        char message[768];
        snprintf(message, sizeof(message), "libmpv.dylib 加载失败：%s", detail ? detail : "unknown dlopen error");
        write_error(error, error_size, message);
        return NULL;
    }

    char message[768];
    snprintf(message, sizeof(message), "内置 libmpv 文件不存在：%s", versioned.fileSystemRepresentation);
    write_error(error, error_size, message);
    return NULL;
}

static bool load_api(ova_mpv_api *api, char *error, size_t error_size) {
    memset(api, 0, sizeof(*api));
    api->library = open_library(error, error_size);
    if (!api->library) return false;
#define LOAD(field, name) if (!load_symbol(api->library, (void **)&api->field, name, error, error_size)) goto failed
    LOAD(create, "mpv_create");
    LOAD(set_option_string, "mpv_set_option_string");
    LOAD(initialize, "mpv_initialize");
    LOAD(request_log_messages, "mpv_request_log_messages");
    LOAD(terminate_destroy, "mpv_terminate_destroy");
    LOAD(command, "mpv_command");
    LOAD(get_property, "mpv_get_property");
    LOAD(set_property, "mpv_set_property");
    LOAD(wait_event, "mpv_wait_event");
    LOAD(error_string, "mpv_error_string");
    LOAD(render_create, "mpv_render_context_create");
    LOAD(render_set_update_callback, "mpv_render_context_set_update_callback");
    LOAD(render, "mpv_render_context_render");
    LOAD(render_free, "mpv_render_context_free");
#undef LOAD
    return true;
failed:
    dlclose(api->library);
    memset(api, 0, sizeof(*api));
    return false;
}

static void close_api(ova_mpv_api *api) {
    if (api->library) dlclose(api->library);
    memset(api, 0, sizeof(*api));
}

static void *get_proc_address(void *context, const char *name) {
    (void)context;
    CFStringRef symbol = CFStringCreateWithCString(kCFAllocatorDefault, name, kCFStringEncodingASCII);
    void *address = CFBundleGetFunctionPointerForName(
        CFBundleGetBundleWithIdentifier(CFSTR("com.apple.opengl")), symbol);
    CFRelease(symbol);
    return address;
}

@implementation OvaMpvOpenGLView
- (instancetype)initWithFrame:(NSRect)frame {
    NSOpenGLPixelFormatAttribute attributes[] = {
        NSOpenGLPFAAccelerated,
        NSOpenGLPFADoubleBuffer,
        NSOpenGLPFAOpenGLProfile, NSOpenGLProfileVersion3_2Core,
        0,
    };
    NSOpenGLPixelFormat *format = [[NSOpenGLPixelFormat alloc] initWithAttributes:attributes];
    self = [super initWithFrame:frame pixelFormat:format];
    if (self) {
        self.autoresizingMask = NSViewNotSizable;
        self.wantsBestResolutionOpenGLSurface = YES;
        GLint swap = 1;
        [self.openGLContext setValues:&swap forParameter:NSOpenGLCPSwapInterval];
        [self.openGLContext makeCurrentContext];
        glClearColor(0, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        [self.openGLContext flushBuffer];
    }
    return self;
}

- (void)renderFrame {
    ova_mpv_player *player = self.player;
    if (!player || !player->render_context) return;
    [self.openGLContext makeCurrentContext];
    NSRect pixels = [self convertRectToBacking:self.bounds];
    mpv_opengl_fbo fbo = { .fbo = 0, .w = (int)pixels.size.width, .h = (int)pixels.size.height, .internal_format = 0 };
    int flip = 1;
    mpv_render_param params[] = {
        { MPV_RENDER_PARAM_OPENGL_FBO, &fbo },
        { MPV_RENDER_PARAM_FLIP_Y, &flip },
        { 0, NULL },
    };
    int status = player->api.render(player->render_context, params);
    if (status < 0) atomic_store(&player->render_error, status);
    [self.openGLContext flushBuffer];
}

- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    [self renderFrame];
}
@end

static void render_update(void *context) {
    OvaMpvOpenGLView *view = (__bridge OvaMpvOpenGLView *)context;
    dispatch_async(dispatch_get_main_queue(), ^{ [view renderFrame]; });
}

static NSRect native_frame(NSView *parent, ova_mpv_bounds bounds) {
    double y = parent.bounds.size.height - bounds.y - bounds.height;
    return NSMakeRect(bounds.x, y, MAX(bounds.width, 1), MAX(bounds.height, 1));
}

static bool check_status(ova_mpv_player *player, int status, char *error, size_t error_size) {
    if (status >= 0) return true;
    const char *detail = player->api.error_string(status);
    write_error(error, error_size, detail);
    return false;
}

bool ova_mpv_probe(char *error, size_t error_size) {
    ova_mpv_api api;
    if (!load_api(&api, error, error_size)) return false;
    close_api(&api);
    return true;
}

void *ova_mpv_create(void *parent_view, ova_mpv_bounds bounds, char *error, size_t error_size) {
    if (!parent_view) {
        write_error(error, error_size, "macOS 视图不可用");
        return NULL;
    }
    ova_mpv_player *player = calloc(1, sizeof(*player));
    if (!player || !load_api(&player->api, error, error_size)) {
        free(player);
        return NULL;
    }
    player->handle = player->api.create();
    if (!player->handle) {
        write_error(error, error_size, "mpv_create 失败");
        close_api(&player->api);
        free(player);
        return NULL;
    }

    const char *options[][2] = {
        {"config", "no"}, {"load-scripts", "no"}, {"input-default-bindings", "no"},
        {"input-media-keys", "no"}, {"autoload-files", "no"}, {"audio-file-auto", "no"},
        {"sub-auto", "no"}, {"hwdec", "videotoolbox-copy,auto-safe"},
        {"vo", "libmpv"}, {"keep-open", "yes"},
    };
    for (size_t index = 0; index < sizeof(options) / sizeof(options[0]); index++) {
        if (!check_status(player, player->api.set_option_string(player->handle, options[index][0], options[index][1]), error, error_size)) {
            ova_mpv_destroy(player);
            return NULL;
        }
    }
    if (!check_status(player, player->api.initialize(player->handle), error, error_size)) {
        ova_mpv_destroy(player);
        return NULL;
    }
    player->api.request_log_messages(player->handle, "error");

    __block OvaMpvOpenGLView *view = nil;
    void (^create_view)(void) = ^{
        NSView *parent = (__bridge NSView *)parent_view;
        view = [[OvaMpvOpenGLView alloc] initWithFrame:native_frame(parent, bounds)];
        view.player = player;
        [parent addSubview:view positioned:NSWindowAbove relativeTo:nil];
        [view.openGLContext makeCurrentContext];
    };
    if (NSThread.isMainThread) create_view(); else dispatch_sync(dispatch_get_main_queue(), create_view);
    if (!view || !view.openGLContext) {
        write_error(error, error_size, "无法创建 macOS OpenGL 视频视图");
        ova_mpv_destroy(player);
        return NULL;
    }
    player->view = view;

    mpv_opengl_init_params gl_init = { .get_proc_address = get_proc_address, .get_proc_address_ctx = NULL };
    const char *api_type = "opengl";
    mpv_render_param params[] = {
        { MPV_RENDER_PARAM_API_TYPE, (void *)api_type },
        { MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl_init },
        { 0, NULL },
    };
    mpv_render_param *params_pointer = params;
    __block int render_status = 0;
    void (^create_renderer)(void) = ^{
        [view.openGLContext makeCurrentContext];
        render_status = player->api.render_create(&player->render_context, player->handle, params_pointer);
    };
    if (NSThread.isMainThread) create_renderer(); else dispatch_sync(dispatch_get_main_queue(), create_renderer);
    if (!check_status(player, render_status, error, error_size)) {
        ova_mpv_destroy(player);
        return NULL;
    }
    player->api.render_set_update_callback(player->render_context, render_update, (__bridge void *)view);
    return player;
}

bool ova_mpv_load(void *opaque, const char *path, double initial_position, char *error, size_t error_size) {
    ova_mpv_player *player = opaque;
    if (!player || !path) { write_error(error, error_size, "libmpv 未初始化"); return false; }
    const char *command[] = {"loadfile", path, "replace", NULL};
    player->ready = false;
    player->ended = false;
    player->last_error[0] = '\0';
    player->initial_position = MAX(initial_position, 0);
    player->initial_seek_pending = player->initial_position > 0;
    return check_status(player, player->api.command(player->handle, command), error, error_size);
}

bool ova_mpv_set_bounds(void *opaque, ova_mpv_bounds bounds, char *error, size_t error_size) {
    ova_mpv_player *player = opaque;
    if (!player || !player->view.superview) { write_error(error, error_size, "libmpv 视图不可用"); return false; }
    void (^update)(void) = ^{
        NSRect frame = native_frame(player->view.superview, bounds);
        if (NSEqualRects(player->view.frame, frame)) return;
        player->view.frame = frame;
        [player->view update];
        [player->view renderFrame];
    };
    if (NSThread.isMainThread) update(); else dispatch_async(dispatch_get_main_queue(), update);
    return true;
}

static void drain_events(ova_mpv_player *player) {
    while (true) {
        mpv_event *event = player->api.wait_event(player->handle, 0);
        if (!event || event->event_id == MPV_EVENT_NONE) break;
        if (event->event_id == MPV_EVENT_FILE_LOADED) {
            player->ready = true;
            player->ended = false;
            if (player->initial_seek_pending) {
                double position = player->initial_position;
                player->api.set_property(player->handle, "time-pos", MPV_FORMAT_DOUBLE, &position);
                player->initial_seek_pending = false;
            }
        } else if (event->event_id == MPV_EVENT_END_FILE && event->data) {
            mpv_event_end_file *end = event->data;
            player->ended = end->reason == MPV_END_FILE_REASON_EOF;
            if (end->reason == MPV_END_FILE_REASON_ERROR) {
                snprintf(player->last_error, sizeof(player->last_error), "%s", player->api.error_string(end->error));
            }
        } else if (event->event_id == MPV_EVENT_LOG_MESSAGE && event->data) {
            mpv_event_log_message *message = event->data;
            const char *prefix = message->prefix ? message->prefix : "";
            if (strcmp(prefix, "ad") == 0 || strcmp(prefix, "ao") == 0 || strstr(prefix, "audio")) {
                snprintf(player->last_error, sizeof(player->last_error),
                         "音频解码错误：%.420s", message->text ? message->text : "unknown audio error");
                player->last_error[strcspn(player->last_error, "\r\n")] = '\0';
            }
        }
    }
}

bool ova_mpv_get_state(void *opaque, ova_mpv_state *state, char *error, size_t error_size) {
    ova_mpv_player *player = opaque;
    if (!player || !state) { write_error(error, error_size, "libmpv 未初始化"); return false; }
    drain_events(player);
    memset(state, 0, sizeof(*state));
    state->ready = player->ready;
    state->paused = true;
    state->volume = 100;
    state->ended = player->ended;
    if (player->last_error[0]) snprintf(state->error, sizeof(state->error), "%s", player->last_error);
    int render_error = atomic_load(&player->render_error);
    if (render_error < 0) {
        snprintf(state->error, sizeof(state->error), "视频渲染失败：%s", player->api.error_string(render_error));
    }
    if (!player->ready) return true;
    player->api.get_property(player->handle, "duration", MPV_FORMAT_DOUBLE, &state->duration);
    player->api.get_property(player->handle, "time-pos", MPV_FORMAT_DOUBLE, &state->current_time);
    int paused = 1, muted = 0;
    player->api.get_property(player->handle, "pause", MPV_FORMAT_FLAG, &paused);
    player->api.get_property(player->handle, "mute", MPV_FORMAT_FLAG, &muted);
    player->api.get_property(player->handle, "volume", MPV_FORMAT_DOUBLE, &state->volume);
    state->paused = paused != 0;
    state->muted = muted != 0;
    int64_t audio_id = 0;
    state->has_audio = player->api.get_property(player->handle, "aid", MPV_FORMAT_INT64, &audio_id) >= 0 && audio_id > 0;
    return true;
}

static bool set_flag(ova_mpv_player *player, const char *name, bool value, char *error, size_t error_size) {
    int flag = value ? 1 : 0;
    return check_status(player, player->api.set_property(player->handle, name, MPV_FORMAT_FLAG, &flag), error, error_size);
}

bool ova_mpv_play(void *opaque, char *error, size_t error_size) {
    ova_mpv_player *player = opaque;
    return player && set_flag(player, "pause", false, error, error_size);
}

bool ova_mpv_pause(void *opaque, char *error, size_t error_size) {
    ova_mpv_player *player = opaque;
    return player && set_flag(player, "pause", true, error, error_size);
}

bool ova_mpv_seek(void *opaque, double position, char *error, size_t error_size) {
    ova_mpv_player *player = opaque;
    if (!player) { write_error(error, error_size, "libmpv 未初始化"); return false; }
    double safe = MAX(position, 0);
    return check_status(player, player->api.set_property(player->handle, "time-pos", MPV_FORMAT_DOUBLE, &safe), error, error_size);
}

bool ova_mpv_set_volume(void *opaque, double volume, char *error, size_t error_size) {
    ova_mpv_player *player = opaque;
    if (!player) { write_error(error, error_size, "libmpv 未初始化"); return false; }
    double safe = MIN(MAX(volume, 0), 100);
    return check_status(player, player->api.set_property(player->handle, "volume", MPV_FORMAT_DOUBLE, &safe), error, error_size);
}

bool ova_mpv_set_muted(void *opaque, bool muted, char *error, size_t error_size) {
    ova_mpv_player *player = opaque;
    return player && set_flag(player, "mute", muted, error, error_size);
}

void ova_mpv_destroy(void *opaque) {
    ova_mpv_player *player = opaque;
    if (!player) return;
    if (player->render_context) {
        player->api.render_set_update_callback(player->render_context, NULL, NULL);
        __block mpv_render_context *context = player->render_context;
        void (^free_renderer)(void) = ^{
            [player->view.openGLContext makeCurrentContext];
            player->api.render_free(context);
        };
        if (NSThread.isMainThread) free_renderer(); else dispatch_sync(dispatch_get_main_queue(), free_renderer);
        player->render_context = NULL;
    }
    if (player->view) {
        void (^remove_view)(void) = ^{ [player->view removeFromSuperview]; player->view.player = NULL; };
        if (NSThread.isMainThread) remove_view(); else dispatch_sync(dispatch_get_main_queue(), remove_view);
        player->view = nil;
    }
    if (player->handle) player->api.terminate_destroy(player->handle);
    close_api(&player->api);
    free(player);
}
