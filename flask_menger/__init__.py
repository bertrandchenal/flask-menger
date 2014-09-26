import datetime

from flask import (current_app, Blueprint, render_template, request, json,
                   send_file)
from flask.ext.login import login_required
from menger import connect, get_space, iter_spaces

from flask_menger.web import build_xlsx, dice

menger_app = Blueprint('menger', __name__,
                       template_folder='templates/menger',
                       static_folder='static/menger')

def sorter(order):
    def wrapped(el):
        name = el['name']
        return order.index(name)
    return wrapped

@menger_app.route('/mng/<method>.<ext>', methods=['GET', 'POST'])
@login_required
def mng(method, ext):
    res = {}
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
            if hasattr(space, 'dim_order'):
                order = space.dim_order
                space_info['dimensions'].sort(key=sorter(order))
            spaces.append(space_info)

        return json.jsonify(spaces=spaces)

    query = json.loads(request.args.get('query', '{}'))

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

    return json.jsonify(**res)


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

    with connect(current_app.config['MENGER_DATABASE']):
        data, columns = dice(dimensions, measures,
                             format_type=format_type,
                             filters=filters)
        res['data'] = data
        res['columns'] = columns

        return res

def compute_filename(pattern):
    now = datetime.datetime.now()
    return '%s.xlsx' % now.strftime(pattern)
