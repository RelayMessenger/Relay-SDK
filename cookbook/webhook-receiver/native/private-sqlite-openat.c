#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE 1

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

struct test_options {
  const char *race_path;
  const char *race_target;
  const char *uid_path;
  uid_t uid;
  int has_uid;
};

static void fail_message(
  const char *label,
  const char *message,
  const char *path
) {
  fprintf(stderr, "%s %s: %s\n", label, message, path);
  exit(EXIT_FAILURE);
}

static void fail_errno(
  const char *label,
  const char *operation,
  const char *path
) {
  fprintf(
    stderr,
    "%s could not %s %s: %s\n",
    label,
    operation,
    path,
    strerror(errno)
  );
  exit(EXIT_FAILURE);
}

static int same_identity(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static int is_trusted_sticky_temp(const char *path) {
  return strcmp(path, "/tmp") == 0
    || strcmp(path, "/var/tmp") == 0
    || strcmp(path, "/private/tmp") == 0
    || strcmp(path, "/private/var/tmp") == 0;
}

static uid_t observed_uid(
  const char *path,
  const struct stat *stats,
  const struct test_options *options
) {
  if (
    options->has_uid
    && options->uid_path != NULL
    && strcmp(path, options->uid_path) == 0
  ) {
    return options->uid;
  }
  return stats->st_uid;
}

static void validate_directory(
  const char *path,
  const struct stat *stats,
  int immediate,
  const char *label,
  const struct test_options *options
) {
  if (!S_ISDIR(stats->st_mode)) {
    fail_message(label, "path component is not a directory", path);
  }

  const uid_t uid = observed_uid(path, stats, options);
  const uid_t owner = geteuid();
  const mode_t mode = stats->st_mode & 07777;
  if (immediate) {
    if (uid != owner) {
      fail_message(
        label,
        "directory must be owned by the current user",
        path
      );
    }
    if ((mode & 0777) != 0700) {
      fail_message(label, "directory must be owner-only (0700)", path);
    }
    return;
  }

  if (uid != 0 && uid != owner) {
    fail_message(
      label,
      "ancestor directory must be owned by root or the current user",
      path
    );
  }
  if ((mode & 0022) == 0) {
    return;
  }
  if (
    uid == 0
    && (mode & 01000) != 0
    && is_trusted_sticky_temp(path)
  ) {
    return;
  }
  fail_message(
    label,
    "ancestor directory must not be group- or world-writable",
    path
  );
}

static void validate_file(const struct stat *stats, const char *label) {
  if (!S_ISREG(stats->st_mode)) {
    fail_message(label, "database must be a regular file", "database");
  }
  if (stats->st_uid != geteuid()) {
    fail_message(
      label,
      "database must be owned by the current user",
      "database"
    );
  }
  if ((stats->st_mode & 0777) != 0600) {
    fail_message(label, "database must be owner-only (0600)", "database");
  }
}

static char *join_path(const char *parent, const char *name) {
  const size_t parent_length = strlen(parent);
  const size_t name_length = strlen(name);
  const int root = strcmp(parent, "/") == 0;
  const size_t length = parent_length + name_length + (root ? 1 : 2);
  char *result = malloc(length);
  if (result == NULL) {
    fprintf(stderr, "private SQLite openat helper ran out of memory\n");
    exit(EXIT_FAILURE);
  }
  if (root) {
    snprintf(result, length, "/%s", name);
  } else {
    snprintf(result, length, "%s/%s", parent, name);
  }
  return result;
}

static int count_components(const char *directory) {
  char *copy = strdup(directory);
  if (copy == NULL) {
    fprintf(stderr, "private SQLite openat helper ran out of memory\n");
    exit(EXIT_FAILURE);
  }
  int count = 0;
  char *save = NULL;
  for (
    char *part = strtok_r(copy, "/", &save);
    part != NULL;
    part = strtok_r(NULL, "/", &save)
  ) {
    count += 1;
  }
  free(copy);
  return count;
}

static uid_t parse_uid(const char *value) {
  errno = 0;
  char *end = NULL;
  const unsigned long parsed = strtoul(value, &end, 10);
  if (
    errno != 0
    || end == value
    || *end != '\0'
    || parsed > UINT_MAX
  ) {
    fprintf(stderr, "invalid test UID: %s\n", value);
    exit(EXIT_FAILURE);
  }
  return (uid_t)parsed;
}

static struct test_options parse_options(int argc, char **argv) {
  struct test_options options = {0};
  for (int index = 3; index < argc; index += 2) {
    if (index + 1 >= argc) {
      fprintf(stderr, "native helper option has no value: %s\n", argv[index]);
      exit(EXIT_FAILURE);
    }
    const char *name = argv[index];
    const char *value = argv[index + 1];
    if (strcmp(name, "--test-uid-path") == 0) {
      options.uid_path = value;
    } else if (strcmp(name, "--test-uid") == 0) {
      options.uid = parse_uid(value);
      options.has_uid = 1;
    } else if (strcmp(name, "--test-race-path") == 0) {
      options.race_path = value;
    } else if (strcmp(name, "--test-race-target") == 0) {
      options.race_target = value;
    } else {
      fprintf(stderr, "unknown native helper option: %s\n", name);
      exit(EXIT_FAILURE);
    }
  }
  if ((options.uid_path == NULL) != (options.has_uid == 0)) {
    fprintf(stderr, "test UID override requires both path and UID\n");
    exit(EXIT_FAILURE);
  }
  if ((options.race_path == NULL) != (options.race_target == NULL)) {
    fprintf(stderr, "test race injection requires both path and target\n");
    exit(EXIT_FAILURE);
  }
  return options;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: private-sqlite-openat PATH LABEL [test options]\n");
    return EXIT_FAILURE;
  }
  const char *path = argv[1];
  const char *label = argv[2];
  if (path[0] != '/') {
    fail_message(label, "database path must be absolute", path);
  }
  const struct test_options options = parse_options(argc, argv);

  char *directory = strdup(path);
  if (directory == NULL) {
    fprintf(stderr, "private SQLite openat helper ran out of memory\n");
    return EXIT_FAILURE;
  }
  char *slash = strrchr(directory, '/');
  if (slash == NULL || slash[1] == '\0') {
    fail_message(label, "database path has no filename", path);
  }
  char *filename = strdup(slash + 1);
  if (filename == NULL) {
    fprintf(stderr, "private SQLite openat helper ran out of memory\n");
    return EXIT_FAILURE;
  }
  if (slash == directory) {
    directory[1] = '\0';
  } else {
    *slash = '\0';
  }

  const int component_count = count_components(directory);
  int parent_fd = open(
    "/",
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  );
  if (parent_fd < 0) {
    fail_errno(label, "open directory", "/");
  }
  struct stat root_stats;
  if (fstat(parent_fd, &root_stats) != 0) {
    fail_errno(label, "inspect directory", "/");
  }
  validate_directory(
    "/",
    &root_stats,
    component_count == 0,
    label,
    &options
  );

  char *parts = strdup(directory);
  char *logical = strdup("/");
  if (parts == NULL || logical == NULL) {
    fprintf(stderr, "private SQLite openat helper ran out of memory\n");
    return EXIT_FAILURE;
  }
  char *save = NULL;
  int component_index = 0;
  for (
    char *name = strtok_r(parts, "/", &save);
    name != NULL;
    name = strtok_r(NULL, "/", &save)
  ) {
    component_index += 1;
    char *child_path = join_path(logical, name);
    struct stat before;
    int created = 0;
    if (fstatat(parent_fd, name, &before, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno != ENOENT) {
        fail_errno(label, "inspect directory", child_path);
      }
      if (
        options.race_path != NULL
        && strcmp(child_path, options.race_path) == 0
      ) {
        if (symlinkat(options.race_target, parent_fd, name) != 0) {
          fail_errno(label, "inject test symlink", child_path);
        }
      }
      if (mkdirat(parent_fd, name, 0700) != 0) {
        if (errno == EEXIST) {
          fail_message(
            label,
            "path changed while it was being created",
            child_path
          );
        }
        fail_errno(label, "create directory", child_path);
      }
      created = 1;
      if (fstatat(parent_fd, name, &before, AT_SYMLINK_NOFOLLOW) != 0) {
        fail_errno(label, "inspect created directory", child_path);
      }
    }
    if (S_ISLNK(before.st_mode)) {
      fail_message(label, "path must not contain symbolic links", child_path);
    }
    if (!S_ISDIR(before.st_mode)) {
      fail_message(label, "path component is not a directory", child_path);
    }

    const int child_fd = openat(
      parent_fd,
      name,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    );
    if (child_fd < 0) {
      fail_errno(label, "open directory", child_path);
    }
    struct stat opened;
    if (fstat(child_fd, &opened) != 0) {
      fail_errno(label, "inspect opened directory", child_path);
    }
    if (!same_identity(&before, &opened)) {
      fail_message(
        label,
        "path changed while it was being opened",
        child_path
      );
    }
    if (created) {
      if (fchmod(child_fd, 0700) != 0) {
        fail_errno(label, "set directory permissions", child_path);
      }
      if (fstat(child_fd, &opened) != 0) {
        fail_errno(label, "inspect created directory", child_path);
      }
    }
    validate_directory(
      child_path,
      &opened,
      component_index == component_count,
      label,
      &options
    );
    close(parent_fd);
    parent_fd = child_fd;
    free(logical);
    logical = child_path;
  }

  struct stat before_file;
  int created_file = 0;
  if (
    fstatat(parent_fd, filename, &before_file, AT_SYMLINK_NOFOLLOW) != 0
  ) {
    if (errno != ENOENT) {
      fail_errno(label, "inspect database", path);
    }
    created_file = 1;
  } else {
    if (S_ISLNK(before_file.st_mode)) {
      fail_message(label, "database must not be a symbolic link", path);
    }
    validate_file(&before_file, label);
  }

  const int file_fd = openat(
    parent_fd,
    filename,
    O_RDWR | O_NOFOLLOW | O_CLOEXEC
      | (created_file ? O_CREAT | O_EXCL : 0),
    0600
  );
  if (file_fd < 0) {
    fail_errno(label, "open database", path);
  }
  if (created_file && fchmod(file_fd, 0600) != 0) {
    fail_errno(label, "set database permissions", path);
  }
  struct stat opened_file;
  struct stat linked_file;
  if (fstat(file_fd, &opened_file) != 0) {
    fail_errno(label, "inspect opened database", path);
  }
  if (
    fstatat(parent_fd, filename, &linked_file, AT_SYMLINK_NOFOLLOW) != 0
  ) {
    fail_errno(label, "inspect linked database", path);
  }
  if (!same_identity(&opened_file, &linked_file)) {
    fail_message(label, "database changed while it was being opened", path);
  }
  validate_file(&opened_file, label);

  close(file_fd);
  close(parent_fd);
  free(logical);
  free(parts);
  free(filename);
  free(directory);
  return EXIT_SUCCESS;
}
