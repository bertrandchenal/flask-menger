import datetime
from hashlib import md5

from flask import (current_app, Blueprint, render_template, request, json,
                   send_file)
from flask.ext.login import login_required
from menger import connect, get_space, iter_spaces, register

from flask_menger.web import build_xlsx, dice

menger_app = Blueprint('menger', __name__,
                       template_folder='templates/menger',
                       static_folder='static/menger')


class LRU:

    def __init__(self, size=1000):
        self.fresh = {}
        self.stale = {}
        self.size = size

    def get(self, key, default=None):
        if key in self.fresh:
            return self.fresh[key]

        if key in self.stale:
            value = self.stale[key]
            # Promote key to fresh dict
            self.set(key, value)
            return value
        return default

    def clean(self, partial=False):
        if partial:
            # Discard only stale data
            self.stale = self.fresh
            self.fresh = {}
            return

        # Full clean
        self.stale = {}
        self.fresh = {}

    def set(self, key, value):
        self.fresh[key] = value
        if len(self.fresh) > self.size:
            self.clean(partial=True)

QUERY_CACHE = LRU()
register('load', QUERY_CACHE.clean)

@menger_app.route('/mng/<method>.<ext>', methods=['GET', 'POST'])
@login_required
def mng(method, ext):
    get_permission = current_app.config.get('MENGER_FILTER')
    if get_permission:
        filters = get_permission()
    else:
        filters = None

    if method == 'info':
        spaces = []
        for space in iter_spaces():
            space_info = {
                'name': space._name,
                'measures': [{
                    'name': m.name,
                    'label': m.label,
                } for m in space._measures],
                'dimensions': [{
                    'name': d.name,
                    'label': d.label,
                    'levels': d.levels,
                } for d in space._dimensions],
                'label': space._label,
            }
            spaces.append(space_info)

        return json.jsonify(spaces=spaces)

    raw_query = request.args.get('query', '{}')
    query = json.loads(raw_query)

    # Build unique id for query
    h = md5(raw_query.encode())
    if filters:
        filters_str = str(sorted(filters.items())).decode()
        h.update(filters_str)
    qid = h.hexdigest()

    cached_value = QUERY_CACHE.get(qid)
    if cached_value is not None:
        return cached_value

    res = {}
    if method == 'drill':
        with connect(current_app.config['MENGER_DATABASE']):
            spc_name = query.get('space')
            spc = get_space(spc_name)
            if not spc:
                return ('space "%s" not found' % spc_name, 404)

            name = query.get('dimension')
            if not hasattr(spc, name):
                return ('space "%s" has not dimension %s' % (spc_name, name),
                        404)
            dim = getattr(spc, name)
            value = tuple(query.get('value', []))
            data = list(dim.drill(value))
            offset = len(value)
            mk_label = lambda x: dim.format(value + (x,), offset=offset)
            res['data'] = [(d, mk_label(d)) for d in data]

    elif method == 'dice':
        res = do_dice(query, filters, ext)
        if ext == 'xlsx':
            output_file = build_xlsx(res)
            attachment_filename = compute_filename(
                current_app.config['MENGER_EXPORT_PATTERN'])
            return send_file(output_file, as_attachment=True,
                     attachment_filename=attachment_filename)

    else:
        return ('Unknown method "%s"' % method, 404)

    if ext != 'json':
        return 'Unknown extension "%s"' % ext, 404

    json_res = json.jsonify(**res)
    QUERY_CACHE.set(qid, json_res)
    return json_res


@menger_app.route('/')
@login_required
def home():
    return render_template("index.html")


def do_dice(query, filters, ext):
    res = {}
    format_type = 'xlsx' if ext == 'xlsx' else None
    dimensions = query.get('dimensions', [])
    for d in dimensions:
        d[1] = tuple(d[1] or [])

    measures = query.get('measures')
    if not measures:
        return ('Key "measures" is empty', 404)

    skip_zero = query.get('skip_zero')
    with connect(current_app.config['MENGER_DATABASE']):
        return dice(dimensions, measures,
                             format_type=format_type,
                             filters=filters, skip_zero=skip_zero)

def compute_filename(pattern):
    now = datetime.datetime.now()
    return '%s.xlsx' % now.strftime(pattern)
