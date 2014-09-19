from collections import defaultdict
from itertools import groupby, product, takewhile, chain
import logging
import os
from tempfile import mkdtemp

from menger import Dimension, Measure, get_space


logger = logging.getLogger('menger.flask')
not_none = lambda x: x is not None


def get_label(space, name, value):
    value = filter(not_none, value)
    dim = get_dimension(space, name)
    if not value:
        return dim.label
    return "%s: %s" % (dim.label, dim.format(value))


def get_dimension(space, name):
    if not hasattr(space, name):
        raise Exception('Space %s has not attribute %s.' % (space.name, name))
    dim = getattr(space, name)
    if not isinstance(dim, Dimension):
        raise Exception('%s is not a dimension on space  %s.' % (
            space.name, name))
    return dim


def get_head(values):
    """
    Return a tuple of the first non-None items in values list
    """
    return tuple(takewhile(not_none, values))


def get_measure(name):
    space_name, name = name.split('.')
    space = get_space(space_name)
    if not hasattr(space, name):
        raise Exception('Space %s has not attribute %s.' % (space._name, name))
    msr = getattr(space, name)
    if not isinstance(msr, Measure):
        raise Exception('%s is not a measure on space  %s.' % (
            space._name, name))

    return msr


def listed(fn):
    def wrapper(*a, **kw):
        return list(fn(*a, **kw))
    return wrapper

@listed
def build_line(dimensions, key, coordinates, type=type, split=True):
    for dim, values, coord in zip(dimensions, key, coordinates):
        coord_name, coord_tuple = coord
        for pos, value in enumerate(values):
            if coord_tuple[pos] is None:
                value = [None] * pos + [value]
                yield dim.format(value, offset=pos, type=type)

@listed
def build_headers(spc, coordinates, force_parent=None):
    for coordinate in coordinates:
        for pos, value in enumerate(coordinate[1]):
            if value is not None:
                continue

            dim = get_dimension(spc, coordinate[0])
            label = dim.levels[pos]
            if force_parent is  None:
                parent = get_label(spc, coordinate[0], coordinate[1])
            else:
                parent = force_parent

            yield {
                'label': label,
                'type': 'dimension',
                'parent': parent,
            }


def dice(coordinates, measures, format_type=None, filters=None):
    # Get space
    spc_name = measures[0].split('.')[0]
    spc = get_space(spc_name)
    if not spc:
        raise Exception('Space %s not found' % spc_name)

    # Search for a pivot
    pivot_name = None
    regular_names = []
    for name, _ in coordinates:
        if name in regular_names:
            if pivot_name and pivot_name != name:
                # Double pivot not supported
                continue
            pivot_name = name
        else:
            regular_names.append(name)

    # clean regular_names
    while pivot_name in regular_names:
        regular_names.remove(pivot_name)

    msr_cols = []
    for m in measures:
        sname = m.split('.')[0]
        s = get_space(sname)
        msr = get_measure(m)
        msr_cols.append({
            'label': s._label + '/' + msr.label,
            'type': 'measure',
            'name': msr.name,
        })

    # No pivot, return regular output
    if not pivot_name:
        dim_cols = build_headers(spc, coordinates)
        data_dict = dice_by_msr(coordinates, measures, filters=filters)
        d_drills = [list(get_dimension(spc, d).glob(v)) for d, v in coordinates]
        data = []
        dimensions = [get_dimension(spc, d) for d, v in coordinates]
        measures = [get_measure(m) for m in measures]

        for key in product(*d_drills):
            line = build_line(dimensions, key, coordinates, type=format_type)
            line.extend(m.format(v, type=format_type) \
                        for m, v in zip(measures, data_dict[key]))
            data.append(line)
        return data, dim_cols + msr_cols

    pivot_dim = get_dimension(spc, pivot_name)
    # split coordinates and get pivot values depth
    depth = None
    pivot_coords = []
    regular_coords = [d for d in coordinates if d[0] in regular_names]
    for d in coordinates:
        name, vals = d
        if name != pivot_name:
            continue
        if depth is None:
            depth = len(vals)
        elif len(vals) != depth:
            # Values len mismatch on pivot coordinates
            continue
        pivot_coords.append(d)

    # Query db for each member of pivot
    datas = []
    for c in pivot_coords:
        data = {}
        datas.append(
            dice_by_msr(regular_coords + [c], measures, filters=filters)
        )

    r_drills = [get_dimension(spc, d).glob(v) for d, v in regular_coords]
    pivot_heads = []
    pivot_tails = set()
    for c, v in pivot_coords:
        head = get_head(v)
        # Ignore mal-constructed pivot coordinates
        if pivot_heads and len(pivot_heads[-1]) != len(head):
            continue

        pivot_heads.append(head)
        cut = len(head)
        for child in get_dimension(spc, c).glob(v):
            pivot_tails.add(child[cut:])

    pivot_tails = sorted(pivot_tails)
    merged_data = []

    # Prepare dim & measures list for formating
    reg_dims = [get_dimension(spc, c) for c, v in regular_coords]
    measures = [get_measure(m) for m in measures]

    for base_key in product(*r_drills):
        for tail in pivot_tails:
            # Fill line with regular coordinates
            line = build_line(reg_dims, base_key, regular_coords,
                              type=format_type)

            # Extend line for each pivot tails
            for pos, head in enumerate(pivot_heads):
                # Add dim value in pivot col
                if pos == 0:
                    line.extend(
                        build_line([pivot_dim], [head+tail], pivot_coords,
                                   type=format_type)
                    )

                key = base_key + (head + tail,)
                vals = datas[pos][key]
                if vals is None:
                    continue
                # Add measure values
                line.extend(m.format(v, type=format_type) \
                            for m,v in zip(measures, vals))

            # Format line
            merged_data.append(line)

    # Construct columns metadata
    cols = build_headers(spc, regular_coords)
    pivot_cols = build_headers(spc, [pivot_coords[0]], force_parent='')
    cols.extend(pivot_cols)

    for head in pivot_heads:
        prefix = pivot_dim.format(head, type=format_type)
        cols.extend({
            'label': prefix,
            'type': 'measure',
            'name': m['name'],
            'parent': m['label'],
        } for m in msr_cols)

    return merged_data, cols


def dice_by_msr(coordinates, measures, filters=None):
    # Create one group of measures per space
    spc_msr = groupby((m.split('.') for m in measures),
                     lambda x: x[0])

    data = defaultdict(lambda: [0 for _ in measures])
    key_len = len(coordinates)
    for spc_pos, (spc_name, msrs) in enumerate(spc_msr):
        spc = get_space(spc_name)
        if not spc:
            raise Exception('space "%s" not found' % spc_name)

        filters = filters or {}
        for key, vals in spc.dice(coordinates, (m[1] for m in msrs), filters):
            for pos, val in enumerate(vals):
                data[key][spc_pos + pos] = val
    return data


def build_xlsx(res):
    import openpyxl
    from openpyxl.cell import get_column_letter

    columns = res['columns']
    headers = []
    for col in columns:
        headers.append(col.get('parent'))

    wb = openpyxl.Workbook()
    sheet = wb.active
    sheet.title = 'Results'
    offset = 1

    if any(headers):
        offset += 1
        last_val = None
        merge_from = None
        for pos, val in enumerate(headers):
            if last_val is not None and val == last_val:
                if merge_from is None:
                    merge_from = pos
            else:
                if merge_from is not None:
                    sheet.merge_cells('%s1:%s1' % (
                        get_column_letter(merge_from),
                        get_column_letter(pos),
                    ))
                    merge_from = None

                last_val = val
                sheet.cell('%s1' % get_column_letter(pos+1)).value = val

    for pos, c in enumerate(columns):
        cell_id = '%s%s' % (get_column_letter(pos+1), offset)
        sheet.cell(cell_id).value = c['label']

    for line in res['data']:
        offset += 1
        for pos, value in enumerate(line):
            cell_id = '%s%s' % (get_column_letter(pos+1), offset)
            if isinstance(value, dict):
                sheet.cell(cell_id).style = value['style']
                value = value['value']
            sheet.cell(cell_id).value = value

    out = os.path.join(mkdtemp(), 'result.xlsx')
    wb.save(out)
    return out

