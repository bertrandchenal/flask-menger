import errno
import os
import shutil

MAX_CACHE = 1000

class DummyCache:

    def get(self, *args):
        return None

    def set(self, *args):
        return None


class FSCache:

    def __init__(self, root, max_cache=None):
        self.root = root
        self.max_cache = max_cache or MAX_CACHE
        self.reset(clean=False)

    def get(self, qid):
        if not self.root:
            return
        full_root = os.path.join(self.root, qid)
        try:
            with open(full_root, 'rb') as fp:
                os.utime(full_root) # update access time
                return fp.read()
        except FileNotFoundError:
            return None

    def set(self, qid, content):
        if not self.root:
            return
        full_root = os.path.join(self.root, qid)
        with open(full_root, 'wb') as fp:
            fp.write(content)

        cached_files = [
            os.path.join(self.root, f) \
            for f in os.listdir(self.root)
        ]
        nb_cached = len(cached_files)
        if nb_cached  and nb_cached> MAX_CACHE:
            oldest = min(cached_files, key=os.path.getctime)
            os.unlink(oldest)

    def reset(self, clean=True):
        if not self.root:
            return
        if clean:
            try:
                shutil.rmtree(self.root)
            except FileNotFoundError:
                pass
        try:
            os.mkdir(self.root)
        except OSError as e:
            if e.errno != errno.EEXIST:
                raise e
