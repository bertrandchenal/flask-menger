from hashlib import md5
import datetime
import gzip

from flask import (current_app, Blueprint, render_template, request, json,
                   send_file)
from menger import connect, get_space, iter_spaces, register

from flask_menger.web import build_xlsx, dice, LimitException
from flask_menger.util import DummyCache, FSCache

fs_cache = DummyCache()
menger_app = Blueprint('menger', __name__,
                       template_folder='templates/menger',
                       static_folder='static/menger')
def register_app(app):
    app.register_blueprint(menger_app)
    # Force a non-readonly query to let table creation proceed
    with connect(app.config['MENGER_DATABASE'], init=True):
        pass

@menger_app.record
def init_cache(state):
    global fs_cache
    app = state.app
    cache_dir = app.config.get('MENGER_CACHE_DIR')
    max_cache = app.config.get('MENGER_MAX_CACHE')
    if cache_dir:
        fs_cache = FSCache(cache_dir, max_cache)
        register('clear_cache', fs_cache.reset)


# TODO ext should be ony json|xlsx (not text)
# so the route should be /mng/<type>/<method>.<ext>
# where type can be 'graph' or 'table'

@menger_app.route('/mng/<method>.<ext>', methods=['GET', 'POST'])
def mng(method, ext):
    get_permission = current_app.config.get('MENGER_FILTER')
    filters = []
    msr_perm = {}
    if get_permission:
        perms = get_permission()
        filters = perms.get('drill', [])
        msr_perm = perms.get('measure', {})

    if method == 'info':
        spaces = []
        for space in iter_spaces():
            if space._name in msr_perm:
                mp = msr_perm[space._name]
                msr_info = [{
                    'name': m.name,
                    'label': m.label,
                } for m in space._measures if m.name in mp]
            else:
                msr_info = [{
                    'name': m.name,
                    'label': m.label,
                } for m in space._measures]
            space_info = {
                'name': space._name,
                'measures': msr_info,
                'dimensions': [{
                    'name': d.name,
                    'label': d.label,
                    'levels': [l.label for l in d.levels.values()],
                } for d in space._dimensions],
                'label': space._label,
            }
            spaces.append(space_info)

        return json.jsonify(spaces=spaces)

    query = expand_query(method)
    spc_name = query.get('space')

    # Not cached to avoid trashing other queries
    if method == 'search':
        with connect(current_app.config['MENGER_DATABASE']):
            spc = get_space(spc_name)
            if not spc:
                return ('space "%s" not found' % spc_name, 404)

            name = query.get('dimension')
            if not hasattr(spc, name):
                return ('space "%s" has not dimension %s' % (spc_name, name),
                            404)
            dim = getattr(spc, name)
            res = list(dim.search(query['value'], int(query['max_depth'])))
            return json.jsonify(data=res)


    # Build unique id for query
    query_string = json.dumps(sorted(query.items()))
    h = md5(json.dumps(query_string).encode() + ext.encode())
    if filters:
        filters_str = str(sorted(filters)).encode()
        h.update(filters_str)
    qid = h.hexdigest()

    # Return cached value if any
    cached_value = fs_cache.get(qid)
    if cached_value is not None:
        resp = current_app.response_class(
            mimetype='application/json',
        )
        accept_encoding = request.headers.get('Accept-Encoding', '')
        if 'gzip' not in accept_encoding.lower():
            resp.set_data(gzip.decompress(cached_value))
        else:
            resp.headers['Content-Encoding'] = 'gzip'
            resp.set_data(cached_value)
        return resp

    res = {}
    if method == 'drill':
        with connect(current_app.config['MENGER_DATABASE']):
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
            data.extend(dim.aliases(value))
            offset = len(value)
            mk_label = lambda x: dim.format(value + (x,), fmt_type='txt',
                                            offset=offset)
            res['data'] = [(d, mk_label(d)) for d in data]

    elif method == 'dice':
        with connect(current_app.config['MENGER_DATABASE']):
            # Add user filters to the permission one
            query_filters = query.get('filters', [])
            measures = query['measures']
            spc_name = measures[0].split('.')[0]
            spc = get_space(spc_name)
            for dim_name, filter_val, depth in query_filters:
                dim = getattr(spc, dim_name)
                coord = (None,) * (depth-1) + (filter_val,)
                filters.append((dim_name, list(dim.glob(coord))))
            try:
                res = do_dice(query, filters, ext)
            except LimitException as e:
                return json.jsonify(error='Request too big (%s)'% str(e))

            if ext == 'xlsx':
                output_file = build_xlsx(res)
                attachment_filename = compute_filename(
                    current_app.config.get('MENGER_EXPORT_PATTERN',
                    '%Y-%m%d'))
                return send_file(output_file, as_attachment=True,
                         attachment_filename=attachment_filename)

    else:
        return ('Unknown method "%s"' % method, 404)

    if ext not in ('json', 'txt'):
        return 'Unknown extension "%s"' % ext, 404

    # Cache result
    json_res = json.dumps(res)
    zipped_res = gzip.compress(json_res.encode())
    fs_cache.set(qid, zipped_res)

    # Return response
    resp = current_app.response_class(
            mimetype='application/json',
        )
    accept_encoding = request.headers.get('Accept-Encoding', '')
    if 'gzip' not in accept_encoding.lower():
        resp.set_data(json_res)
    else:
        resp.headers['Content-Encoding'] = 'gzip'
        resp.set_data(zipped_res)
    return resp


def expand_query(method):
    raw_query = request.args.get('query', '{}')
    query = json.loads(raw_query)

    if method == 'drill':
        spc = get_space(query['space'])
        dim = getattr(spc, query['dimension'])
        query['value'] = dim.expand(query['value'])

    return query


@menger_app.route('/')
def home():
    return render_template("index.html")


def do_dice(query, filters, ext):
    res = {}
    dimensions = query.get('dimensions', [])
    measures = query.get('measures')
    if not measures:
        return ('Key "measures" is empty', 404)

    limit = query.get('limit')
    if limit is not None:
        try:
            limit = int(limit)
        except ValueError:
            limit = None

    return dice(dimensions, measures,
                format_type=ext,
                filters=filters,
                skip_zero=query.get('skip_zero'),
                msr_fmt=query.get('msr_fmt'),
                pivot_on=query.get('pivot_on'),
                limit=limit,
                sort_by=query.get('sort_by'),
            )

def compute_filename(pattern):
    now = datetime.datetime.now()
    return '%s.xlsx' % now.strftime(pattern)
