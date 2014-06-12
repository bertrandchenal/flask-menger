from flask import current_app, Blueprint, render_template, request, json
from flask.ext.login import login_required

from flask_menger.web import build_xlsx, dice
from menger import connect, get_space, iter_spaces

menger_app = Blueprint('menger', __name__,
                       template_folder='templates/menger',
                       static_folder='static/menger')

@menger_app.route('/mng/<method>.<ext>', methods=['GET', 'POST'])
@login_required
def mng(method, ext):
    res = {}

    if method == 'info':
        for name, space in iter_spaces():
            res[name] = {
                'measures': [{
                    'name': m.name,
                    'label': m.label,
                } for m in space._measures],
                'dimensions': [{
                    'name': d.name,
                    'label': d.label,
                    'depth': d.depth
                } for d in space._dimensions],
                'label': space._label,
            }
        return json.jsonify(**res)

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
            res['data'] = data

    elif method == 'dice':
        data = None
        with connect(current_app.config['MENGER_DATABASE']):
            dimensions = query.get('dimensions', [])
            for d in dimensions:
                d[1] = tuple(d[1] or [])

            measures = query.get('measures')
            if not measures:
                return ('Key "measures" is empty', 404)

            data, columns = dice(dimensions, measures)
            res['data'] = data
            res['columns'] = columns

            if ext == 'xlsx':
                return build_xlsx(res)

    else:
        return ('Unknown method "%s"' % method, 404)

    if ext != 'json':
        return 'Unknown extension "%s"' % ext, 404

    return json.jsonify(**res)


@menger_app.route('/')
@login_required
def home():
    return render_template("index.html")


